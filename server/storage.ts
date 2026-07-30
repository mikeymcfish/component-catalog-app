import {
  users, cases, compartments, components, tools, adapters, componentBooks, componentBookItems,
  type User, type InsertUser,
  type Case, type InsertCase,
  type Compartment, type InsertCompartment,
  type Component, type InsertComponent,
  type Tool, type InsertTool,
  type Adapter, type InsertAdapter,
  type ComponentBook, type InsertComponentBook,
  type ComponentBookItem, type InsertComponentBookItem,
  type ComponentBookWithItems, type ComponentBookSearchResult,
  type CaseWithCompartments
} from "@shared/schema";
import {
  getCompartmentPosition,
  getCaseLayerLayouts,
  UNSORTED_CASE_COLS,
  UNSORTED_CASE_MODEL,
  UNSORTED_CASE_NAME,
  UNSORTED_CASE_ROWS,
} from "@shared/case-layouts";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { eq, and, isNull, like, or } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { acquireJsonStorageProcessLock } from "./storage-process-lock";
import {
  createUniformCustomCaseLayout,
  safeParseCustomCaseLayout,
  type CustomCaseLayoutGeometry,
} from "@shared/custom-case-layout";
import {
  getManagedModelAssetId,
  parseCalibrationForModel,
  type CaseModelCalibration,
} from "@shared/model-calibration";
import {
  parseComponentModelRotationForModel,
} from "@shared/component-model-rotation";

function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function componentBookItemMatchesQuery(item: ComponentBookItem, book: ComponentBook, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  return [
    item.name,
    item.category,
    item.partNumber,
    item.value,
    item.packageSize,
    item.notes,
    book.name,
    book.manufacturer,
    book.packageSize,
    book.description,
    book.notes,
  ].some(value => value?.toLowerCase().includes(normalizedQuery));
}

function adapterMatchesQuery(adapter: Adapter, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  return [
    adapter.name,
    adapter.category,
    adapter.manufacturer,
    adapter.modelNumber,
    adapter.productUrl,
    adapter.endpointA,
    adapter.endpointAType,
    adapter.endpointB,
    adapter.endpointBType,
    adapter.location,
    adapter.compatibility,
    adapter.notes,
  ].some(value => value?.toLowerCase().includes(normalizedQuery));
}

function normalizeNewCaseModelCalibrations(case_: InsertCase): InsertCase {
  return {
    ...case_,
    topModel3dCalibration: parseCalibrationForModel(
      case_.topModel3dCalibration,
      case_.topModel3dUrl,
    ),
    bottomModel3dCalibration: parseCalibrationForModel(
      case_.bottomModel3dCalibration,
      case_.bottomModel3dUrl,
    ),
  };
}

function normalizeCaseModelCalibrationUpdates(
  existingCase: Case,
  updates: Partial<InsertCase>,
): Partial<InsertCase> {
  const normalizedUpdates = { ...updates };
  const nextTopModelUrl = hasOwn(updates, "topModel3dUrl")
    ? updates.topModel3dUrl
    : existingCase.topModel3dUrl;
  const nextBottomModelUrl = hasOwn(updates, "bottomModel3dUrl")
    ? updates.bottomModel3dUrl
    : existingCase.bottomModel3dUrl;

  const previousTopAssetId = getManagedModelAssetId(existingCase.topModel3dUrl);
  const nextTopAssetId = getManagedModelAssetId(nextTopModelUrl);
  if (!nextTopAssetId || previousTopAssetId !== nextTopAssetId) {
    normalizedUpdates.topModel3dCalibration = null;
  } else if (hasOwn(updates, "topModel3dCalibration")) {
    normalizedUpdates.topModel3dCalibration = parseCalibrationForModel(
      updates.topModel3dCalibration,
      nextTopModelUrl,
    );
  }

  const previousBottomAssetId = getManagedModelAssetId(existingCase.bottomModel3dUrl);
  const nextBottomAssetId = getManagedModelAssetId(nextBottomModelUrl);
  if (!nextBottomAssetId || previousBottomAssetId !== nextBottomAssetId) {
    normalizedUpdates.bottomModel3dCalibration = null;
  } else if (hasOwn(updates, "bottomModel3dCalibration")) {
    normalizedUpdates.bottomModel3dCalibration = parseCalibrationForModel(
      updates.bottomModel3dCalibration,
      nextBottomModelUrl,
    );
  }

  return normalizedUpdates;
}

function normalizeNewComponentModelRotation(component: InsertComponent): InsertComponent {
  return {
    ...component,
    model3dRotation: normalizeComponentRotationForModel(
      component.model3dRotation,
      component.model3dUrl,
    ),
  };
}

function normalizeComponentRotationForModel(
  rotation: InsertComponent["model3dRotation"],
  modelUrl: string | null | undefined,
) {
  if (rotation === null || rotation === undefined) return null;
  const normalizedRotation = parseComponentModelRotationForModel(rotation, modelUrl);
  if (!normalizedRotation) {
    throw new Error("Component model rotation must match the active GLB asset");
  }
  return normalizedRotation;
}

function normalizeComponentModelRotationUpdates(
  existingComponent: Component,
  updates: Partial<InsertComponent>,
): Partial<InsertComponent> {
  const normalizedUpdates = { ...updates };
  const nextModelUrl = hasOwn(updates, "model3dUrl")
    ? updates.model3dUrl
    : existingComponent.model3dUrl;
  const previousAssetId = getManagedModelAssetId(existingComponent.model3dUrl);
  const nextAssetId = getManagedModelAssetId(nextModelUrl);

  if (!nextAssetId) {
    normalizedUpdates.model3dRotation = null;
  } else if (hasOwn(updates, "model3dRotation")) {
    normalizedUpdates.model3dRotation = normalizeComponentRotationForModel(
      updates.model3dRotation,
      nextModelUrl,
    );
  } else if (previousAssetId !== nextAssetId) {
    normalizedUpdates.model3dRotation = null;
  }

  return normalizedUpdates;
}

function isUnsortedCase(case_: Pick<Case, "model">) {
  return case_.model === UNSORTED_CASE_MODEL;
}

function normalizeLayoutGeometry(
  value: unknown,
  case_: { model: string; rows: number; cols: number; hasBottom?: boolean | null },
): CustomCaseLayoutGeometry | null {
  if (!case_.model.startsWith("CUSTOM-")) return null;

  const dimensions = {
    rows: case_.rows,
    cols: case_.cols,
    hasBottom: Boolean(case_.hasBottom),
  };
  const parsed = safeParseCustomCaseLayout(value, dimensions);
  return parsed.success
    ? parsed.data
    : createUniformCustomCaseLayout(dimensions.rows, dimensions.cols, dimensions.hasBottom);
}

function compareCases(left: Case, right: Case) {
  if (isUnsortedCase(left)) return -1;
  if (isUnsortedCase(right)) return 1;

  return left.sortOrder - right.sortOrder || left.id - right.id;
}

function sortActiveCases(casesToSort: Case[]) {
  return casesToSort
    .filter(case_ => case_.isActive)
    .sort(compareCases);
}

function getNextCaseSortOrder(casesToInspect: Case[]) {
  const sortOrders = casesToInspect
    .filter(case_ => case_.isActive && !isUnsortedCase(case_))
    .map(case_ => case_.sortOrder);

  return sortOrders.length > 0 ? Math.max(...sortOrders) + 1 : 0;
}

function hasSameCaseIdSet(left: number[], right: number[]) {
  if (left.length !== right.length) return false;

  const leftIds = new Set(left);
  const rightIds = new Set(right);
  if (leftIds.size !== left.length || leftIds.size !== rightIds.size) return false;

  return left.every(id => rightIds.has(id));
}

export type SetCaseModelCalibrationResult =
  | { status: "updated"; case: Case }
  | { status: "not_found" }
  | { status: "asset_mismatch" };

export interface IStorage {
  // User methods
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Case methods
  getCases(): Promise<Case[]>;
  getCase(id: number): Promise<Case | undefined>;
  getCaseWithCompartments(id: number): Promise<CaseWithCompartments | undefined>;
  createCase(case_: InsertCase): Promise<Case>;
  updateCase(id: number, updates: Partial<InsertCase>): Promise<Case | undefined>;
  setCaseModelCalibration(
    id: number,
    part: "top" | "bottom",
    assetId: string,
    calibration: CaseModelCalibration | null,
  ): Promise<SetCaseModelCalibrationResult>;
  reorderCases(caseIds: number[]): Promise<Case[] | undefined>;
  deleteCase(id: number): Promise<boolean>;
  isModelAssetReferenced(url: string): Promise<boolean>;
  needsDefaultCaseModelBackfill(): Promise<boolean>;
  completeDefaultCaseModelBackfill(): Promise<void>;

  // Compartment methods
  getCompartmentsByCase(caseId: number): Promise<Compartment[]>;
  getCompartment(id: number): Promise<Compartment | undefined>;
  createCompartment(compartment: InsertCompartment): Promise<Compartment>;

  // Component methods
  getComponents(): Promise<Component[]>;
  getComponent(id: number): Promise<Component | undefined>;
  getComponentByCompartment(compartmentId: number): Promise<Component | undefined>;
  createComponent(component: InsertComponent): Promise<Component>;
  updateComponent(id: number, updates: Partial<InsertComponent>): Promise<Component | undefined>;
  deleteComponent(id: number): Promise<boolean>;
  searchComponents(query: string): Promise<Component[]>;
  shiftComponentsInCase(targetCompartmentId: number, insertPosition: number): Promise<void>;

  // Tool methods
  getTools(): Promise<Tool[]>;
  createTool(tool: InsertTool): Promise<Tool>;
  updateTool(id: number, updates: Partial<InsertTool>): Promise<Tool | undefined>;
  deleteTool(id: number): Promise<boolean>;

  // Adapter methods
  getAdapters(): Promise<Adapter[]>;
  getAdapter(id: number): Promise<Adapter | undefined>;
  createAdapter(adapter: InsertAdapter): Promise<Adapter>;
  updateAdapter(id: number, updates: Partial<InsertAdapter>): Promise<Adapter | undefined>;
  deleteAdapter(id: number): Promise<boolean>;
  searchAdapters(query: string): Promise<Adapter[]>;

  // Component book methods
  getComponentBooks(): Promise<ComponentBookWithItems[]>;
  getComponentBook(id: number): Promise<ComponentBookWithItems | undefined>;
  createComponentBook(book: InsertComponentBook): Promise<ComponentBook>;
  updateComponentBook(id: number, updates: Partial<InsertComponentBook>): Promise<ComponentBook | undefined>;
  deleteComponentBook(id: number): Promise<boolean>;
  getComponentBookItems(bookId: number): Promise<ComponentBookItem[]>;
  createComponentBookItem(item: InsertComponentBookItem): Promise<ComponentBookItem>;
  updateComponentBookItem(id: number, updates: Partial<InsertComponentBookItem>): Promise<ComponentBookItem | undefined>;
  deleteComponentBookItem(id: number): Promise<boolean>;
  searchComponentBookItems(query: string): Promise<ComponentBookSearchResult[]>;
}

// PostgreSQL Storage Implementation
export class PostgreSQLStorage implements IStorage {
  private db: ReturnType<typeof drizzle>;

  constructor() {
    const sql = neon(process.env.DATABASE_URL!);
    this.db = drizzle(sql);
  }

  // User methods
  async getUser(id: number): Promise<User | undefined> {
    const result = await this.db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await this.db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const result = await this.db.insert(users).values(user).returning();
    return result[0];
  }

  // Case methods
  async getCases(): Promise<Case[]> {
    const result = await this.db.select().from(cases);
    return sortActiveCases(result);
  }

  async getCase(id: number): Promise<Case | undefined> {
    const result = await this.db.select().from(cases).where(eq(cases.id, id));
    return result[0];
  }

  async getCaseWithCompartments(id: number): Promise<CaseWithCompartments | undefined> {
    const case_ = await this.getCase(id);
    if (!case_) return undefined;

    const caseCompartments = await this.db.select().from(compartments).where(eq(compartments.caseId, id));

    const compartmentsWithComponents = await Promise.all(
      caseCompartments.map(async (compartment) => {
        const component = await this.getComponentByCompartment(compartment.id);
        return { ...compartment, component };
      })
    );

    return {
      ...case_,
      compartments: compartmentsWithComponents
    };
  }

  async createCase(case_: InsertCase): Promise<Case> {
    const normalizedCase = normalizeNewCaseModelCalibrations(case_);
    const sortOrder = await this.getNextCaseSortOrder();
    const result = await this.db.insert(cases).values({
      ...normalizedCase,
      layoutGeometry: normalizeLayoutGeometry(normalizedCase.layoutGeometry, normalizedCase),
      sortOrder,
    }).returning();
    const newCase = result[0];

    // Create compartments for the new case
    await this.createCompartmentsForCase(newCase);

    return newCase;
  }

  async isModelAssetReferenced(url: string): Promise<boolean> {
    const componentReference = await this.db
      .select({ id: components.id })
      .from(components)
      .where(eq(components.model3dUrl, url))
      .limit(1);
    if (componentReference.length > 0) return true;

    const caseReference = await this.db
      .select({ id: cases.id })
      .from(cases)
      .where(or(eq(cases.topModel3dUrl, url), eq(cases.bottomModel3dUrl, url)))
      .limit(1);
    return caseReference.length > 0;
  }

  async needsDefaultCaseModelBackfill(): Promise<boolean> {
    // Existing PostgreSQL catalogs are never mutated repeatedly at startup.
    // New preset cases receive defaults in the normal create-case flow.
    return false;
  }

  async completeDefaultCaseModelBackfill(): Promise<void> {
    return;
  }

  private async getNextCaseSortOrder() {
    const existingCases = await this.db.select().from(cases);
    return getNextCaseSortOrder(existingCases);
  }

  private async createCompartmentsForCase(case_: Case) {
    const compartmentInserts = [];
    const layerLayouts = getCaseLayerLayouts(case_);

    for (const layout of layerLayouts) {
      for (let row = 1; row <= layout.rows; row++) {
        for (let col = 1; col <= layout.cols; col++) {
          compartmentInserts.push({
            caseId: case_.id,
            position: getCompartmentPosition(case_, row, col),
            row,
            col,
            layer: layout.layer
          });
        }
      }
    }

    await this.db.insert(compartments).values(compartmentInserts);
    console.log(`Created ${compartmentInserts.length} case compartments`);
  }

  async updateCase(id: number, updates: Partial<InsertCase>): Promise<Case | undefined> {
    const existingCase = await this.getCase(id);
    if (!existingCase) return undefined;

    const normalizedUpdates = normalizeCaseModelCalibrationUpdates(existingCase, updates);
    const result = await this.db.update(cases).set(normalizedUpdates).where(eq(cases.id, id)).returning();
    return result[0];
  }

  async setCaseModelCalibration(
    id: number,
    part: "top" | "bottom",
    assetId: string,
    calibration: CaseModelCalibration | null,
  ): Promise<SetCaseModelCalibrationResult> {
    if (calibration && calibration.assetId !== assetId) return { status: "asset_mismatch" };
    const activeUrl = `/uploads/models/${assetId}.glb`;
    const result = part === "top"
      ? await this.db.update(cases)
        .set({ topModel3dCalibration: calibration })
        .where(and(eq(cases.id, id), eq(cases.topModel3dUrl, activeUrl)))
        .returning()
      : await this.db.update(cases)
        .set({ bottomModel3dCalibration: calibration })
        .where(and(eq(cases.id, id), eq(cases.bottomModel3dUrl, activeUrl)))
        .returning();

    if (result[0]) return { status: "updated", case: result[0] };
    return await this.getCase(id) ? { status: "asset_mismatch" } : { status: "not_found" };
  }

  async reorderCases(caseIds: number[]): Promise<Case[] | undefined> {
    const activeCases = await this.getCases();
    const reorderableCaseIds = activeCases
      .filter(case_ => !isUnsortedCase(case_))
      .map(case_ => case_.id);

    if (!hasSameCaseIdSet(caseIds, reorderableCaseIds)) {
      return undefined;
    }

    await Promise.all(
      caseIds.map((id, sortOrder) =>
        this.db.update(cases).set({ sortOrder }).where(eq(cases.id, id))
      )
    );

    return this.getCases();
  }

  async deleteCase(id: number): Promise<boolean> {
    try {
      // First delete all components in this case
      const caseCompartments = await this.db.select().from(compartments).where(eq(compartments.caseId, id));
      for (const compartment of caseCompartments) {
        await this.db.delete(components).where(eq(components.compartmentId, compartment.id));
      }

      // Then delete all compartments
      await this.db.delete(compartments).where(eq(compartments.caseId, id));

      // Finally delete the case
      const result = await this.db.delete(cases).where(eq(cases.id, id));
      return result.rowCount > 0;
    } catch (error) {
      console.error("Error deleting case:", error);
      return false;
    }
  }

  // Compartment methods
  async getCompartmentsByCase(caseId: number): Promise<Compartment[]> {
    return await this.db.select().from(compartments).where(eq(compartments.caseId, caseId));
  }

  async getCompartment(id: number): Promise<Compartment | undefined> {
    const result = await this.db.select().from(compartments).where(eq(compartments.id, id));
    return result[0];
  }

  async createCompartment(compartment: InsertCompartment): Promise<Compartment> {
    const result = await this.db.insert(compartments).values(compartment).returning();
    return result[0];
  }

  // Component methods
  async getComponents(): Promise<Component[]> {
    return await this.db.select().from(components);
  }

  async getComponent(id: number): Promise<Component | undefined> {
    const result = await this.db.select().from(components).where(eq(components.id, id));
    return result[0];
  }

  async getComponentByCompartment(compartmentId: number): Promise<Component | undefined> {
    const result = await this.db.select().from(components).where(eq(components.compartmentId, compartmentId));
    return result[0];
  }

  async createComponent(component: InsertComponent): Promise<Component> {
    const result = await this.db
      .insert(components)
      .values(normalizeNewComponentModelRotation(component))
      .returning();
    return result[0];
  }

  async updateComponent(id: number, updates: Partial<InsertComponent>): Promise<Component | undefined> {
    // Compare-and-swap on the active model URL so a stale rotation-only update
    // can never attach asset A's correction to a concurrently selected asset B.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existingComponent = await this.getComponent(id);
      if (!existingComponent) return undefined;
      const normalizedUpdates = normalizeComponentModelRotationUpdates(existingComponent, updates);
      const sameActiveModel = existingComponent.model3dUrl === null
        ? isNull(components.model3dUrl)
        : eq(components.model3dUrl, existingComponent.model3dUrl);
      const result = await this.db
        .update(components)
        .set(normalizedUpdates)
        .where(and(eq(components.id, id), sameActiveModel))
        .returning();
      if (result[0]) return result[0];
    }
    throw new Error("Component was modified concurrently; retry the update");
  }

  async deleteComponent(id: number): Promise<boolean> {
    const result = await this.db.delete(components).where(eq(components.id, id));
    return result.rowCount > 0;
  }

  async searchComponents(query: string): Promise<Component[]> {
    const searchTerm = `%${query}%`;
    return await this.db.select().from(components).where(
      or(
        like(components.name, searchTerm),
        like(components.packageSize, searchTerm),
        like(components.notes, searchTerm)
      )
    );
  }

  async shiftComponentsInCase(targetCompartmentId: number, insertPosition: number): Promise<void> {
    // For now, we'll implement a simple move without shifting
    // This can be enhanced later to actually shift components in rows
    // The basic functionality just moves the component to the target compartment
  }

  // Tool methods
  async getTools(): Promise<Tool[]> {
    return await this.db.select().from(tools);
  }

  async createTool(tool: InsertTool): Promise<Tool> {
    const result = await this.db.insert(tools).values(tool).returning();
    return result[0];
  }

  async updateTool(id: number, updates: Partial<InsertTool>): Promise<Tool | undefined> {
    const result = await this.db.update(tools).set(updates).where(eq(tools.id, id)).returning();
    return result[0];
  }

  async deleteTool(id: number): Promise<boolean> {
    const result = await this.db.delete(tools).where(eq(tools.id, id));
    return result.rowCount > 0;
  }

  // Adapter methods
  async getAdapters(): Promise<Adapter[]> {
    return await this.db.select().from(adapters);
  }

  async getAdapter(id: number): Promise<Adapter | undefined> {
    const result = await this.db.select().from(adapters).where(eq(adapters.id, id));
    return result[0];
  }

  async createAdapter(adapter: InsertAdapter): Promise<Adapter> {
    const result = await this.db.insert(adapters).values(adapter).returning();
    return result[0];
  }

  async updateAdapter(id: number, updates: Partial<InsertAdapter>): Promise<Adapter | undefined> {
    const result = await this.db.update(adapters).set(updates).where(eq(adapters.id, id)).returning();
    return result[0];
  }

  async deleteAdapter(id: number): Promise<boolean> {
    const result = await this.db.delete(adapters).where(eq(adapters.id, id));
    return result.rowCount > 0;
  }

  async searchAdapters(query: string): Promise<Adapter[]> {
    const storedAdapters = await this.db.select().from(adapters);
    return storedAdapters.filter(adapter => adapterMatchesQuery(adapter, query));
  }

  // Component book methods
  async getComponentBooks(): Promise<ComponentBookWithItems[]> {
    const books = await this.db.select().from(componentBooks);
    return Promise.all(books.map(async book => ({
      ...book,
      items: await this.getComponentBookItems(book.id),
    })));
  }

  async getComponentBook(id: number): Promise<ComponentBookWithItems | undefined> {
    const result = await this.db.select().from(componentBooks).where(eq(componentBooks.id, id));
    const book = result[0];
    if (!book) return undefined;

    return { ...book, items: await this.getComponentBookItems(id) };
  }

  async createComponentBook(book: InsertComponentBook): Promise<ComponentBook> {
    const result = await this.db.insert(componentBooks).values(book).returning();
    return result[0];
  }

  async updateComponentBook(
    id: number,
    updates: Partial<InsertComponentBook>,
  ): Promise<ComponentBook | undefined> {
    const result = await this.db
      .update(componentBooks)
      .set(updates)
      .where(eq(componentBooks.id, id))
      .returning();
    return result[0];
  }

  async deleteComponentBook(id: number): Promise<boolean> {
    const result = await this.db.delete(componentBooks).where(eq(componentBooks.id, id));
    return result.rowCount > 0;
  }

  async getComponentBookItems(bookId: number): Promise<ComponentBookItem[]> {
    return this.db
      .select()
      .from(componentBookItems)
      .where(eq(componentBookItems.bookId, bookId));
  }

  async createComponentBookItem(item: InsertComponentBookItem): Promise<ComponentBookItem> {
    const result = await this.db.insert(componentBookItems).values(item).returning();
    return result[0];
  }

  async updateComponentBookItem(
    id: number,
    updates: Partial<InsertComponentBookItem>,
  ): Promise<ComponentBookItem | undefined> {
    const result = await this.db
      .update(componentBookItems)
      .set(updates)
      .where(eq(componentBookItems.id, id))
      .returning();
    return result[0];
  }

  async deleteComponentBookItem(id: number): Promise<boolean> {
    const result = await this.db.delete(componentBookItems).where(eq(componentBookItems.id, id));
    return result.rowCount > 0;
  }

  async searchComponentBookItems(query: string): Promise<ComponentBookSearchResult[]> {
    const [books, items] = await Promise.all([
      this.db.select().from(componentBooks),
      this.db.select().from(componentBookItems),
    ]);
    const booksById = new Map(books.map(book => [book.id, book]));

    return items.flatMap(item => {
      const book = booksById.get(item.bookId);
      return book && componentBookItemMatchesQuery(item, book, query)
        ? [{ ...item, book }]
        : [];
    });
  }
}

export class MemStorage implements IStorage {
  protected users: Map<number, User> = new Map();
  protected cases: Map<number, Case> = new Map();
  protected compartments: Map<number, Compartment> = new Map();
  protected components: Map<number, Component> = new Map();
  protected tools: Map<number, Tool> = new Map();
  protected adapters: Map<number, Adapter> = new Map();
  protected componentBooks: Map<number, ComponentBook> = new Map();
  protected componentBookItems: Map<number, ComponentBookItem> = new Map();

  protected userIdCounter = 1;
  protected caseIdCounter = 1;
  protected compartmentIdCounter = 1;
  protected componentIdCounter = 1;
  protected toolIdCounter = 1;
  protected adapterIdCounter = 1;
  protected componentBookIdCounter = 1;
  protected componentBookItemIdCounter = 1;

  constructor(seedDefaultData = true) {
    if (seedDefaultData) {
      this.initializeDefaultData();
    }
  }

  protected initializeDefaultData() {
    // Create a default case with BOX-ALL-144 layout
    const defaultCase: Case = {
      id: this.caseIdCounter++,
      name: "Main Resistors",
      model: "BOX-ALL-144",
      rows: 6,
      cols: 12,
      hasBottom: false,
      description: "Primary resistor storage case",
      closedImageUrl: null,
      openImageUrl: null,
      topModel3dUrl: null,
      topModel3dName: null,
      topModel3dSource: null,
      topModel3dCalibration: null,
      bottomModel3dUrl: null,
      bottomModel3dName: null,
      bottomModel3dSource: null,
      bottomModel3dCalibration: null,
      layoutGeometry: null,
      sortOrder: 0,
      isActive: true,
    };
    this.cases.set(defaultCase.id, defaultCase);

    // Create compartments for BOX-ALL-144 (6 rows × 12 columns)
    for (let row = 1; row <= 6; row++) {
      for (let col = 1; col <= 12; col++) {
        const position = String.fromCharCode(64 + row) + col; // A1, A2, B1, etc.
        const compartment: Compartment = {
          id: this.compartmentIdCounter++,
          caseId: defaultCase.id,
          position,
          row,
          col,
          layer: "top",
        };
        this.compartments.set(compartment.id, compartment);
      }
    }

    this.ensureUnsortedCase();
  }

  protected ensureUnsortedCase() {
    const existingCase = Array.from(this.cases.values())
      .find(case_ => case_.model === UNSORTED_CASE_MODEL);

    if (existingCase) {
      const existingCompartments = Array.from(this.compartments.values())
        .filter(compartment => compartment.caseId === existingCase.id);

      if (existingCompartments.length === 0) {
        this.createCompartmentsForCase(existingCase);
        return true;
      }

      return false;
    }

    const unsortedCase: Case = {
      id: this.caseIdCounter++,
      name: UNSORTED_CASE_NAME,
      model: UNSORTED_CASE_MODEL,
      rows: UNSORTED_CASE_ROWS,
      cols: UNSORTED_CASE_COLS,
      hasBottom: false,
      description: "Temporary holding area for components that have not been assigned to a physical case.",
      closedImageUrl: null,
      openImageUrl: null,
      topModel3dUrl: null,
      topModel3dName: null,
      topModel3dSource: null,
      topModel3dCalibration: null,
      bottomModel3dUrl: null,
      bottomModel3dName: null,
      bottomModel3dSource: null,
      bottomModel3dCalibration: null,
      layoutGeometry: null,
      sortOrder: -1,
      isActive: true,
    };

    this.cases.set(unsortedCase.id, unsortedCase);
    this.createCompartmentsForCase(unsortedCase);
    return true;
  }

  // User methods
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(user => user.username === username);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const user: User = { ...insertUser, id: this.userIdCounter++ };
    this.users.set(user.id, user);
    return user;
  }

  // Case methods
  async getCases(): Promise<Case[]> {
    return sortActiveCases(Array.from(this.cases.values()));
  }

  async getCase(id: number): Promise<Case | undefined> {
    return this.cases.get(id);
  }

  async getCaseWithCompartments(id: number): Promise<CaseWithCompartments | undefined> {
    const case_ = this.cases.get(id);
    if (!case_) return undefined;

    const caseCompartments = Array.from(this.compartments.values())
      .filter(comp => comp.caseId === id)
      .map(comp => {
        const component = Array.from(this.components.values())
          .find(c => c.compartmentId === comp.id);
        return { ...comp, component };
      });

    return { ...case_, compartments: caseCompartments };
  }

  async createCase(insertCase: InsertCase): Promise<Case> {
    const normalizedInsertCase = normalizeNewCaseModelCalibrations(insertCase);
    const case_: Case = {
      ...normalizedInsertCase,
      id: this.caseIdCounter++,
      isActive: true,
      sortOrder: getNextCaseSortOrder(Array.from(this.cases.values())),
      hasBottom: normalizedInsertCase.hasBottom || false,
      description: normalizedInsertCase.description || null,
      closedImageUrl: normalizedInsertCase.closedImageUrl ?? null,
      openImageUrl: normalizedInsertCase.openImageUrl ?? null,
      topModel3dUrl: normalizedInsertCase.topModel3dUrl ?? null,
      topModel3dName: normalizedInsertCase.topModel3dName ?? null,
      topModel3dSource: normalizedInsertCase.topModel3dSource ?? null,
      topModel3dCalibration: normalizedInsertCase.topModel3dCalibration ?? null,
      bottomModel3dUrl: normalizedInsertCase.bottomModel3dUrl ?? null,
      bottomModel3dName: normalizedInsertCase.bottomModel3dName ?? null,
      bottomModel3dSource: normalizedInsertCase.bottomModel3dSource ?? null,
      bottomModel3dCalibration: normalizedInsertCase.bottomModel3dCalibration ?? null,
      layoutGeometry: normalizeLayoutGeometry(normalizedInsertCase.layoutGeometry, normalizedInsertCase),
    };
    this.cases.set(case_.id, case_);

    // Create compartments based on model
    this.createCompartmentsForCase(case_);

    return case_;
  }

  protected createCompartmentsForCase(case_: Case) {
    console.log(`Creating case compartments: ${case_.rows}x${case_.cols}, hasBottom: ${case_.hasBottom}`);

    let createdCount = 0;

    for (const layout of getCaseLayerLayouts(case_)) {
      for (let row = 1; row <= layout.rows; row++) {
        for (let col = 1; col <= layout.cols; col++) {
          const compartment: Compartment = {
            id: this.compartmentIdCounter++,
            caseId: case_.id,
            position: getCompartmentPosition(case_, row, col),
            row,
            col,
            layer: layout.layer,
          };
          this.compartments.set(compartment.id, compartment);
          createdCount++;
        }
      }
    }

    console.log(`Created ${createdCount} case compartments`);
  }

  async updateCase(id: number, updates: Partial<InsertCase>): Promise<Case | undefined> {
    const case_ = this.cases.get(id);
    if (!case_) return undefined;

    const normalizedUpdates = normalizeCaseModelCalibrationUpdates(case_, updates);
    const updatedCase = { ...case_, ...normalizedUpdates };
    this.cases.set(id, updatedCase);
    return updatedCase;
  }

  async setCaseModelCalibration(
    id: number,
    part: "top" | "bottom",
    assetId: string,
    calibration: CaseModelCalibration | null,
  ): Promise<SetCaseModelCalibrationResult> {
    const case_ = this.cases.get(id);
    if (!case_) return { status: "not_found" };
    if (calibration && calibration.assetId !== assetId) return { status: "asset_mismatch" };

    const activeUrl = part === "top" ? case_.topModel3dUrl : case_.bottomModel3dUrl;
    if (getManagedModelAssetId(activeUrl) !== assetId) return { status: "asset_mismatch" };

    const updatedCase = part === "top"
      ? { ...case_, topModel3dCalibration: calibration }
      : { ...case_, bottomModel3dCalibration: calibration };
    this.cases.set(id, updatedCase);
    return { status: "updated", case: updatedCase };
  }

  async isModelAssetReferenced(url: string): Promise<boolean> {
    if (Array.from(this.components.values()).some(component => component.model3dUrl === url)) {
      return true;
    }

    return Array.from(this.cases.values()).some(case_ =>
      case_.topModel3dUrl === url || case_.bottomModel3dUrl === url
    );
  }

  async needsDefaultCaseModelBackfill(): Promise<boolean> {
    return false;
  }

  async completeDefaultCaseModelBackfill(): Promise<void> {
    return;
  }

  async reorderCases(caseIds: number[]): Promise<Case[] | undefined> {
    const activeCases = await this.getCases();
    const reorderableCaseIds = activeCases
      .filter(case_ => !isUnsortedCase(case_))
      .map(case_ => case_.id);

    if (!hasSameCaseIdSet(caseIds, reorderableCaseIds)) {
      return undefined;
    }

    caseIds.forEach((id, sortOrder) => {
      const case_ = this.cases.get(id);
      if (case_) {
        this.cases.set(id, { ...case_, sortOrder });
      }
    });

    return this.getCases();
  }

  async deleteCase(id: number): Promise<boolean> {
    const case_ = this.cases.get(id);
    if (!case_) return false;

    const caseCompartments = Array.from(this.compartments.values())
      .filter(compartment => compartment.caseId === id);
    const compartmentIds = new Set(caseCompartments.map(compartment => compartment.id));

    for (const component of Array.from(this.components.values())) {
      if (compartmentIds.has(component.compartmentId)) {
        this.components.delete(component.id);
      }
    }

    for (const compartment of caseCompartments) {
      this.compartments.delete(compartment.id);
    }

    return this.cases.delete(id);
  }

  // Compartment methods
  async getCompartmentsByCase(caseId: number): Promise<Compartment[]> {
    return Array.from(this.compartments.values())
      .filter(comp => comp.caseId === caseId);
  }

  async getCompartment(id: number): Promise<Compartment | undefined> {
    return this.compartments.get(id);
  }

  async createCompartment(insertCompartment: InsertCompartment): Promise<Compartment> {
    const compartment: Compartment = {
      ...insertCompartment,
      id: this.compartmentIdCounter++,
      layer: insertCompartment.layer || "top"
    };
    this.compartments.set(compartment.id, compartment);
    return compartment;
  }

  // Component methods
  async getComponents(): Promise<Component[]> {
    return Array.from(this.components.values());
  }

  async getComponent(id: number): Promise<Component | undefined> {
    return this.components.get(id);
  }

  async getComponentByCompartment(compartmentId: number): Promise<Component | undefined> {
    return Array.from(this.components.values())
      .find(comp => comp.compartmentId === compartmentId);
  }

  async createComponent(insertComponent: InsertComponent): Promise<Component> {
    const normalizedComponent = normalizeNewComponentModelRotation(insertComponent);
    const component: Component = {
      ...normalizedComponent,
      id: this.componentIdCounter++,
      packageSize: normalizedComponent.packageSize || null,
      quantity: normalizedComponent.quantity || 0,
      minQuantity: normalizedComponent.minQuantity || null,
      datasheetUrl: normalizedComponent.datasheetUrl || null,
      photoUrl: normalizedComponent.photoUrl || null,
      model3dUrl: normalizedComponent.model3dUrl || null,
      model3dName: normalizedComponent.model3dName || null,
      model3dSource: normalizedComponent.model3dSource || null,
      model3dRotation: normalizedComponent.model3dRotation || null,
      notes: normalizedComponent.notes || null,
      checkedOut: normalizedComponent.checkedOut || false,
      checkedOutBy: normalizedComponent.checkedOutBy || null,
      checkedOutDate: normalizedComponent.checkedOutDate || null
    };
    this.components.set(component.id, component);
    return component;
  }

  async updateComponent(id: number, updates: Partial<InsertComponent>): Promise<Component | undefined> {
    const component = this.components.get(id);
    if (!component) return undefined;

    const normalizedUpdates = normalizeComponentModelRotationUpdates(component, updates);
    const updatedComponent = { ...component, ...normalizedUpdates };
    this.components.set(id, updatedComponent);
    return updatedComponent;
  }

  async deleteComponent(id: number): Promise<boolean> {
    return this.components.delete(id);
  }

  async searchComponents(query: string): Promise<Component[]> {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.components.values())
      .filter(comp =>
        comp.name.toLowerCase().includes(lowerQuery) ||
        (comp.packageSize && comp.packageSize.toLowerCase().includes(lowerQuery)) ||
        (comp.notes && comp.notes.toLowerCase().includes(lowerQuery))
      );
  }

  async shiftComponentsInCase(targetCompartmentId: number, insertPosition: number): Promise<void> {
    // Simple implementation for memory storage
    return Promise.resolve();
  }

  // Tool methods
  async getTools(): Promise<Tool[]> {
    return Array.from(this.tools.values());
  }

  async createTool(insertTool: InsertTool): Promise<Tool> {
    const tool: Tool = {
      ...insertTool,
      id: this.toolIdCounter++,
      manufacturer: insertTool.manufacturer ?? null,
      modelNumber: insertTool.modelNumber ?? null,
      productUrl: insertTool.productUrl ?? null,
      imageUrl: insertTool.imageUrl ?? null,
      quantity: insertTool.quantity ?? 1,
      location: insertTool.location ?? null,
      capabilities: insertTool.capabilities ?? null,
      notes: insertTool.notes ?? null,
    };
    this.tools.set(tool.id, tool);
    return tool;
  }

  async updateTool(id: number, updates: Partial<InsertTool>): Promise<Tool | undefined> {
    const tool = this.tools.get(id);
    if (!tool) return undefined;

    const updatedTool = { ...tool, ...updates };
    this.tools.set(id, updatedTool);
    return updatedTool;
  }

  async deleteTool(id: number): Promise<boolean> {
    return this.tools.delete(id);
  }

  // Adapter methods
  async getAdapters(): Promise<Adapter[]> {
    return Array.from(this.adapters.values());
  }

  async getAdapter(id: number): Promise<Adapter | undefined> {
    return this.adapters.get(id);
  }

  async createAdapter(insertAdapter: InsertAdapter): Promise<Adapter> {
    const adapter: Adapter = {
      ...insertAdapter,
      id: this.adapterIdCounter++,
      manufacturer: insertAdapter.manufacturer ?? null,
      modelNumber: insertAdapter.modelNumber ?? null,
      productUrl: insertAdapter.productUrl ?? null,
      imageUrl: insertAdapter.imageUrl ?? null,
      endpointA: insertAdapter.endpointA ?? null,
      endpointAType: insertAdapter.endpointAType ?? null,
      endpointB: insertAdapter.endpointB ?? null,
      endpointBType: insertAdapter.endpointBType ?? null,
      quantity: insertAdapter.quantity ?? 1,
      location: insertAdapter.location ?? null,
      compatibility: insertAdapter.compatibility ?? null,
      notes: insertAdapter.notes ?? null,
    };
    this.adapters.set(adapter.id, adapter);
    return adapter;
  }

  async updateAdapter(
    id: number,
    updates: Partial<InsertAdapter>,
  ): Promise<Adapter | undefined> {
    const adapter = this.adapters.get(id);
    if (!adapter) return undefined;

    const updatedAdapter = { ...adapter, ...updates };
    this.adapters.set(id, updatedAdapter);
    return updatedAdapter;
  }

  async deleteAdapter(id: number): Promise<boolean> {
    return this.adapters.delete(id);
  }

  async searchAdapters(query: string): Promise<Adapter[]> {
    return Array.from(this.adapters.values())
      .filter(adapter => adapterMatchesQuery(adapter, query));
  }

  // Component book methods
  async getComponentBooks(): Promise<ComponentBookWithItems[]> {
    return Promise.all(Array.from(this.componentBooks.values()).map(async book => ({
      ...book,
      items: await this.getComponentBookItems(book.id),
    })));
  }

  async getComponentBook(id: number): Promise<ComponentBookWithItems | undefined> {
    const book = this.componentBooks.get(id);
    if (!book) return undefined;
    return { ...book, items: await this.getComponentBookItems(id) };
  }

  async createComponentBook(insertBook: InsertComponentBook): Promise<ComponentBook> {
    const book: ComponentBook = {
      ...insertBook,
      id: this.componentBookIdCounter++,
      manufacturer: insertBook.manufacturer ?? null,
      packageSize: insertBook.packageSize ?? null,
      productUrl: insertBook.productUrl ?? null,
      imageUrl: insertBook.imageUrl ?? null,
      description: insertBook.description ?? null,
      notes: insertBook.notes ?? null,
    };
    this.componentBooks.set(book.id, book);
    return book;
  }

  async updateComponentBook(
    id: number,
    updates: Partial<InsertComponentBook>,
  ): Promise<ComponentBook | undefined> {
    const book = this.componentBooks.get(id);
    if (!book) return undefined;

    const updatedBook = { ...book, ...updates };
    this.componentBooks.set(id, updatedBook);
    return updatedBook;
  }

  async deleteComponentBook(id: number): Promise<boolean> {
    if (!this.componentBooks.delete(id)) return false;

    for (const [itemId, item] of Array.from(this.componentBookItems.entries())) {
      if (item.bookId === id) this.componentBookItems.delete(itemId);
    }
    return true;
  }

  async getComponentBookItems(bookId: number): Promise<ComponentBookItem[]> {
    return Array.from(this.componentBookItems.values())
      .filter(item => item.bookId === bookId);
  }

  async createComponentBookItem(insertItem: InsertComponentBookItem): Promise<ComponentBookItem> {
    if (!this.componentBooks.has(insertItem.bookId)) {
      throw new Error("Component book not found");
    }

    const item: ComponentBookItem = {
      ...insertItem,
      id: this.componentBookItemIdCounter++,
      category: insertItem.category ?? null,
      partNumber: insertItem.partNumber ?? null,
      value: insertItem.value ?? null,
      packageSize: insertItem.packageSize ?? null,
      quantity: insertItem.quantity ?? null,
      notes: insertItem.notes ?? null,
    };
    this.componentBookItems.set(item.id, item);
    return item;
  }

  async updateComponentBookItem(
    id: number,
    updates: Partial<InsertComponentBookItem>,
  ): Promise<ComponentBookItem | undefined> {
    const item = this.componentBookItems.get(id);
    if (!item) return undefined;
    if (updates.bookId !== undefined && !this.componentBooks.has(updates.bookId)) {
      throw new Error("Component book not found");
    }

    const updatedItem = { ...item, ...updates };
    this.componentBookItems.set(id, updatedItem);
    return updatedItem;
  }

  async deleteComponentBookItem(id: number): Promise<boolean> {
    return this.componentBookItems.delete(id);
  }

  async searchComponentBookItems(query: string): Promise<ComponentBookSearchResult[]> {
    return Array.from(this.componentBookItems.values()).flatMap(item => {
      const book = this.componentBooks.get(item.bookId);
      return book && componentBookItemMatchesQuery(item, book, query)
        ? [{ ...item, book }]
        : [];
    });
  }
}

interface PersistedStorageState {
  version: number;
  counters: {
    userIdCounter: number;
    caseIdCounter: number;
    compartmentIdCounter: number;
    componentIdCounter: number;
    toolIdCounter: number;
    adapterIdCounter: number;
    componentBookIdCounter: number;
    componentBookItemIdCounter: number;
  };
  users: User[];
  cases: Case[];
  compartments: Compartment[];
  components: (Omit<Component, "checkedOutDate"> & { checkedOutDate: string | null })[];
  tools: Tool[];
  adapters: Adapter[];
  componentBooks: ComponentBook[];
  componentBookItems: ComponentBookItem[];
}

function nextId(items: { id: number }[]) {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}

export class JsonFileStorage extends MemStorage {
  private readonly filePath: string;
  private defaultCaseModelBackfillPending = false;

  constructor(filePath = process.env.STORAGE_FILE || path.join(process.cwd(), "data", "storage.json")) {
    super(false);
    this.filePath = filePath;
    this.loadOrInitialize();
  }

  private loadOrInitialize() {
    if (fs.existsSync(this.filePath)) {
      try {
        const rawState = fs.readFileSync(this.filePath, "utf-8");
        const state = JSON.parse(rawState) as Partial<PersistedStorageState>;
        this.loadState(state);
        return;
      } catch (error) {
        const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.filePath, backupPath);
        console.error(`Failed to load ${this.filePath}; backed it up to ${backupPath}`, error);
      }
    }

    this.initializeDefaultData();
    this.save();
  }

  private loadState(state: Partial<PersistedStorageState>) {
    const stateVersion = state.version ?? 0;
    this.defaultCaseModelBackfillPending = stateVersion < 5;
    const loadedUsers = (state.users || []).map(user => ({
      ...user,
    }));
    const loadedCases = (state.cases || []).map((case_, index) => {
      const normalizedCase = {
        ...case_,
        model: case_.model || "BOX-ALL-144",
        rows: case_.rows || 6,
        cols: case_.cols || 12,
        hasBottom: case_.hasBottom ?? false,
        description: case_.description ?? null,
        closedImageUrl: case_.closedImageUrl ?? null,
        openImageUrl: case_.openImageUrl ?? null,
        topModel3dUrl: case_.topModel3dUrl ?? null,
        topModel3dName: case_.topModel3dName ?? null,
        topModel3dSource: case_.topModel3dSource ?? null,
        topModel3dCalibration: parseCalibrationForModel(
          case_.topModel3dCalibration,
          case_.topModel3dUrl,
        ),
        bottomModel3dUrl: case_.bottomModel3dUrl ?? null,
        bottomModel3dName: case_.bottomModel3dName ?? null,
        bottomModel3dSource: case_.bottomModel3dSource ?? null,
        bottomModel3dCalibration: parseCalibrationForModel(
          case_.bottomModel3dCalibration,
          case_.bottomModel3dUrl,
        ),
        sortOrder: case_.model === UNSORTED_CASE_MODEL ? -1 : case_.sortOrder ?? index,
        isActive: case_.isActive ?? true,
      };

      return {
        ...normalizedCase,
        layoutGeometry: normalizeLayoutGeometry(case_.layoutGeometry, normalizedCase),
      };
    });
    const loadedCompartments = state.compartments || [];
    const loadedComponents = (state.components || []).map(component => ({
      ...component,
      packageSize: component.packageSize ?? null,
      quantity: component.quantity ?? 0,
      minQuantity: component.minQuantity ?? 5,
      datasheetUrl: component.datasheetUrl ?? null,
      photoUrl: component.photoUrl ?? null,
      model3dUrl: component.model3dUrl ?? null,
      model3dName: component.model3dName ?? null,
      model3dSource: component.model3dSource ?? null,
      model3dRotation: parseComponentModelRotationForModel(
        component.model3dRotation,
        component.model3dUrl,
      ),
      notes: component.notes ?? null,
      checkedOut: component.checkedOut ?? false,
      checkedOutBy: component.checkedOutBy ?? null,
      checkedOutDate: component.checkedOutDate ? new Date(component.checkedOutDate) : null,
    }));
    const loadedTools = (state.tools || []).map(tool => ({
      ...tool,
      manufacturer: tool.manufacturer ?? null,
      modelNumber: tool.modelNumber ?? null,
      productUrl: tool.productUrl ?? null,
      imageUrl: tool.imageUrl ?? null,
      quantity: tool.quantity ?? 1,
      location: tool.location ?? null,
      capabilities: tool.capabilities ?? null,
      notes: tool.notes ?? null,
    }));
    const loadedAdapters = (state.adapters || []).map(adapter => ({
      ...adapter,
      manufacturer: adapter.manufacturer ?? null,
      modelNumber: adapter.modelNumber ?? null,
      productUrl: adapter.productUrl ?? null,
      imageUrl: adapter.imageUrl ?? null,
      endpointA: adapter.endpointA ?? null,
      endpointAType: adapter.endpointAType ?? null,
      endpointB: adapter.endpointB ?? null,
      endpointBType: adapter.endpointBType ?? null,
      quantity: adapter.quantity ?? 1,
      location: adapter.location ?? null,
      compatibility: adapter.compatibility ?? null,
      notes: adapter.notes ?? null,
    }));
    const loadedComponentBooks = (state.componentBooks || []).map(book => ({
      ...book,
      manufacturer: book.manufacturer ?? null,
      packageSize: book.packageSize ?? null,
      productUrl: book.productUrl ?? null,
      imageUrl: book.imageUrl ?? null,
      description: book.description ?? null,
      notes: book.notes ?? null,
    }));
    const loadedComponentBookItems = (state.componentBookItems || []).map(item => ({
      ...item,
      category: item.category ?? null,
      partNumber: item.partNumber ?? null,
      value: item.value ?? null,
      packageSize: item.packageSize ?? null,
      quantity: item.quantity ?? null,
      notes: item.notes ?? null,
    }));

    this.users = new Map(loadedUsers.map(user => [user.id, user]));
    this.cases = new Map(loadedCases.map(case_ => [case_.id, case_]));
    this.compartments = new Map(loadedCompartments.map(compartment => [compartment.id, compartment]));
    this.components = new Map(loadedComponents.map(component => [component.id, component]));
    this.tools = new Map(loadedTools.map(tool => [tool.id, tool]));
    this.adapters = new Map(loadedAdapters.map(adapter => [adapter.id, adapter]));
    this.componentBooks = new Map(loadedComponentBooks.map(book => [book.id, book]));
    this.componentBookItems = new Map(loadedComponentBookItems.map(item => [item.id, item]));

    this.userIdCounter = state.counters?.userIdCounter ?? nextId(loadedUsers);
    this.caseIdCounter = state.counters?.caseIdCounter ?? nextId(loadedCases);
    this.compartmentIdCounter = state.counters?.compartmentIdCounter ?? nextId(loadedCompartments);
    this.componentIdCounter = state.counters?.componentIdCounter ?? nextId(loadedComponents);
    this.toolIdCounter = state.counters?.toolIdCounter ?? nextId(loadedTools);
    this.adapterIdCounter = state.counters?.adapterIdCounter ?? nextId(loadedAdapters);
    this.componentBookIdCounter = state.counters?.componentBookIdCounter ?? nextId(loadedComponentBooks);
    this.componentBookItemIdCounter = state.counters?.componentBookItemIdCounter ?? nextId(loadedComponentBookItems);

    // Version 7-10 catalogs are valid with implicit empty collections for newer
    // catalog sections and nullable fields on existing records.
    // Avoid rewriting a user's live file just for opening it; the next real
    // mutation persists the complete version 11 shape.
    if (this.ensureUnsortedCase() || stateVersion < 7) {
      this.save();
    }
  }

  private getState(): PersistedStorageState {
    return {
      // Keep legacy state at v4 until the bundled-model backfill finishes.
      // If startup is interrupted, the next run safely retries only null fields.
      version: this.defaultCaseModelBackfillPending ? 4 : 11,
      counters: {
        userIdCounter: this.userIdCounter,
        caseIdCounter: this.caseIdCounter,
        compartmentIdCounter: this.compartmentIdCounter,
        componentIdCounter: this.componentIdCounter,
        toolIdCounter: this.toolIdCounter,
        adapterIdCounter: this.adapterIdCounter,
        componentBookIdCounter: this.componentBookIdCounter,
        componentBookItemIdCounter: this.componentBookItemIdCounter,
      },
      users: Array.from(this.users.values()),
      cases: Array.from(this.cases.values()).sort(compareCases),
      compartments: Array.from(this.compartments.values()),
      components: Array.from(this.components.values()).map(component => ({
        ...component,
        checkedOutDate: component.checkedOutDate ? component.checkedOutDate.toISOString() : null,
      })),
      tools: Array.from(this.tools.values()),
      adapters: Array.from(this.adapters.values()),
      componentBooks: Array.from(this.componentBooks.values()),
      componentBookItems: Array.from(this.componentBookItems.values()),
    };
  }

  private save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.getState(), null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  async createUser(user: InsertUser): Promise<User> {
    const result = await super.createUser(user);
    this.save();
    return result;
  }

  async needsDefaultCaseModelBackfill(): Promise<boolean> {
    return this.defaultCaseModelBackfillPending;
  }

  async completeDefaultCaseModelBackfill(): Promise<void> {
    if (!this.defaultCaseModelBackfillPending) return;
    this.defaultCaseModelBackfillPending = false;
    this.save();
  }

  async createCase(case_: InsertCase): Promise<Case> {
    const result = await super.createCase(case_);
    this.save();
    return result;
  }

  async updateCase(id: number, updates: Partial<InsertCase>): Promise<Case | undefined> {
    const result = await super.updateCase(id, updates);
    if (result) this.save();
    return result;
  }

  async setCaseModelCalibration(
    id: number,
    part: "top" | "bottom",
    assetId: string,
    calibration: CaseModelCalibration | null,
  ): Promise<SetCaseModelCalibrationResult> {
    const result = await super.setCaseModelCalibration(id, part, assetId, calibration);
    if (result.status === "updated") this.save();
    return result;
  }

  async reorderCases(caseIds: number[]): Promise<Case[] | undefined> {
    const result = await super.reorderCases(caseIds);
    if (result) this.save();
    return result;
  }

  async deleteCase(id: number): Promise<boolean> {
    const result = await super.deleteCase(id);
    if (result) this.save();
    return result;
  }

  async createCompartment(compartment: InsertCompartment): Promise<Compartment> {
    const result = await super.createCompartment(compartment);
    this.save();
    return result;
  }

  async createComponent(component: InsertComponent): Promise<Component> {
    const result = await super.createComponent(component);
    this.save();
    return result;
  }

  async updateComponent(id: number, updates: Partial<InsertComponent>): Promise<Component | undefined> {
    const result = await super.updateComponent(id, updates);
    if (result) this.save();
    return result;
  }

  async deleteComponent(id: number): Promise<boolean> {
    const result = await super.deleteComponent(id);
    if (result) this.save();
    return result;
  }

  async createTool(tool: InsertTool): Promise<Tool> {
    const result = await super.createTool(tool);
    this.save();
    return result;
  }

  async updateTool(id: number, updates: Partial<InsertTool>): Promise<Tool | undefined> {
    const result = await super.updateTool(id, updates);
    if (result) this.save();
    return result;
  }

  async deleteTool(id: number): Promise<boolean> {
    const result = await super.deleteTool(id);
    if (result) this.save();
    return result;
  }

  async createAdapter(adapter: InsertAdapter): Promise<Adapter> {
    const result = await super.createAdapter(adapter);
    this.save();
    return result;
  }

  async updateAdapter(
    id: number,
    updates: Partial<InsertAdapter>,
  ): Promise<Adapter | undefined> {
    const result = await super.updateAdapter(id, updates);
    if (result) this.save();
    return result;
  }

  async deleteAdapter(id: number): Promise<boolean> {
    const result = await super.deleteAdapter(id);
    if (result) this.save();
    return result;
  }

  async createComponentBook(book: InsertComponentBook): Promise<ComponentBook> {
    const result = await super.createComponentBook(book);
    this.save();
    return result;
  }

  async updateComponentBook(
    id: number,
    updates: Partial<InsertComponentBook>,
  ): Promise<ComponentBook | undefined> {
    const result = await super.updateComponentBook(id, updates);
    if (result) this.save();
    return result;
  }

  async deleteComponentBook(id: number): Promise<boolean> {
    const result = await super.deleteComponentBook(id);
    if (result) this.save();
    return result;
  }

  async createComponentBookItem(item: InsertComponentBookItem): Promise<ComponentBookItem> {
    const result = await super.createComponentBookItem(item);
    this.save();
    return result;
  }

  async updateComponentBookItem(
    id: number,
    updates: Partial<InsertComponentBookItem>,
  ): Promise<ComponentBookItem | undefined> {
    const result = await super.updateComponentBookItem(id, updates);
    if (result) this.save();
    return result;
  }

  async deleteComponentBookItem(id: number): Promise<boolean> {
    const result = await super.deleteComponentBookItem(id);
    if (result) this.save();
    return result;
  }
}

function createStorage(): IStorage {
  if (process.env.STORAGE_BACKEND === "postgres") {
    return new PostgreSQLStorage();
  }

  const filePath = process.env.STORAGE_FILE || path.join(process.cwd(), "data", "storage.json");
  const processLock = acquireJsonStorageProcessLock(filePath);
  try {
    return new JsonFileStorage(filePath);
  } catch (error) {
    processLock.release();
    throw error;
  }
}

export const storage = createStorage();
