import { lazy, Suspense, useState, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute, useSearch } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Download, Plus, HelpCircle, Eye, Pencil, LayoutGrid, List, Image, Clipboard, FileSpreadsheet, ClipboardList, Tags, Menu, Cpu, Package, AlertTriangle, Grid2X2, Camera, Box, Ruler } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Sidebar from "@/components/sidebar";
import CaseGrid from "@/components/case-grid";
import { CaseImageView, CaseListView, CaseUnorganizedListView } from "@/components/case-component-views";
import EditComponentDialog from "@/components/edit-component-dialog";
import ComponentInfoDialog from "@/components/component-info-dialog";
import AddCaseDialog from "@/components/add-case-dialog";
import CaseImageManagerDialog from "@/components/case-image-manager-dialog";
import CaseLibraryView from "@/components/case-library-view";
import ToolsView from "@/components/tools-view";
import AdaptersView from "@/components/adapters-view";
import ComponentBooksView from "@/components/component-books-view";
import ToolEditorDialog from "@/components/tool-editor-dialog";
import AdapterEditorDialog from "@/components/adapter-editor-dialog";
import EditCaseLayoutDialog from "@/components/edit-case-layout-dialog";
import ImportGuideDialog from "@/components/import-guide-dialog";
import BomLocatorDialog from "@/components/bom-locator-dialog";
import KicadSettingsDialog from "@/components/kicad-settings-dialog";
import FilterDropdown from "@/components/filter-dropdown";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { UNORGANIZED_CASE_MODEL, UNSORTED_CASE_MODEL } from "@shared/case-layouts";
import { parseCustomCaseLayout } from "@shared/custom-case-layout";
import { parseCalibrationForModel } from "@shared/model-calibration";
import { parseComponentModelRotationForModel } from "@shared/component-model-rotation";
import { ADAPTER_ENDPOINT_TYPE_VALUES } from "@shared/schema";
import type {
  CaseWithCompartments,
  Component,
  Compartment,
  Case,
  ComponentBook,
  ComponentBookItem,
  ComponentBookWithItems,
} from "@shared/schema";
import type { Tool } from "@/lib/tools";
import type { Adapter } from "@/lib/adapters";
import { resolveCompartmentSceneLayer } from "@/lib/case-3d-scene/model-set";

type InteractionMode = "view" | "edit";
type DisplayMode = "grid" | "list" | "image" | "case3d";
type CaseModelLayer = "top" | "bottom";

interface Pending2dLayerScroll {
  caseId: number;
  layer: CaseModelLayer;
}

const DISPLAY_MODES = new Set<DisplayMode>(["grid", "list", "image", "case3d"]);
const Case3dView = lazy(() => import("@/components/case-3d-view"));

function parsePositiveInteger(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

const IMPORT_CASE_IMAGE_PATTERN = /^\/uploads\/case-images\/[a-f0-9]{64}\.(?:jpg|png|webp)$/;
const IMPORT_MODEL_PATTERN = /^\/uploads\/models\/[a-f0-9]{64}\.glb$/;
const IMPORT_ADAPTER_ENDPOINT_TYPES = new Set<string>(ADAPTER_ENDPOINT_TYPE_VALUES);
const IMPORT_CATEGORY_IDS: Record<string, number> = {
  resistor: 1,
  capacitor: 2,
  ic: 3,
  diode: 4,
  transistor: 5,
  inductor: 6,
  crystal: 7,
  connector: 8,
  led: 9,
  switch: 10,
  sensor: 11,
  other: 12,
};

type ImportRecord = Record<string, unknown>;
const IMPORTED_COPY_SUFFIX = " (imported)";

function importedCopyName(name: string, maxLength: number) {
  return `${name.slice(0, maxLength - IMPORTED_COPY_SUFFIX.length)}${IMPORTED_COPY_SUFFIX}`;
}

interface PreparedImportCompartment {
  sourceId: number;
  position: string;
  layer: CaseModelLayer;
}

interface PreparedImportCase {
  name: string;
  payload: ImportRecord;
  compartments: PreparedImportCompartment[];
}

interface PreparedImportComponent {
  name: string;
  sourceCompartmentId: number;
  payload: ImportRecord;
}

interface PreparedImportTool {
  name: string;
  payload: ImportRecord;
}

interface PreparedImportAdapter {
  name: string;
  payload: ImportRecord;
}

interface PreparedImportBookItem {
  name: string;
  payload: ImportRecord;
}

interface PreparedImportBook {
  name: string;
  payload: ImportRecord;
  items: PreparedImportBookItem[];
}

interface PreparedCatalogImport {
  cases: PreparedImportCase[];
  components: PreparedImportComponent[];
  tools: PreparedImportTool[];
  adapters: PreparedImportAdapter[];
  componentBooks: PreparedImportBook[];
  includesTools: boolean;
  includesAdapters: boolean;
  includesComponentBooks: boolean;
}

function importRecord(value: unknown, label: string): ImportRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as ImportRecord;
}

function importRequiredText(value: unknown, label: string, maxLength?: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const result = value.trim();
  if (maxLength !== undefined && result.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  }
  return result;
}

function importOptionalText(value: unknown, label: string, maxLength?: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string or null.`);
  const result = value.trim();
  if (!result) return null;
  if (maxLength !== undefined && result.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  }
  return result;
}

function importAdapterEndpointType(value: unknown, label: string) {
  const normalized = importOptionalText(value, label, 50);
  if (normalized !== null && !IMPORT_ADAPTER_ENDPOINT_TYPES.has(normalized)) {
    throw new Error(
      `${label} must be one of: ${ADAPTER_ENDPOINT_TYPE_VALUES.join(", ")}.`,
    );
  }
  return normalized;
}

function importInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function importManagedUrl(
  value: unknown,
  pattern: RegExp,
  label: string,
) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is not a managed upload URL from this catalog.`);
  }
  return value;
}

function importModelSource(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  if (value !== "kicad" && value !== "upload") {
    throw new Error(`${label} must be either "kicad" or "upload".`);
  }
  return value;
}

function prepareCatalogImport(value: unknown): PreparedCatalogImport {
  const data = importRecord(value, "Import file");
  if (!Array.isArray(data.cases)) {
    throw new Error("Import file cases must be an array.");
  }
  if (data.components !== undefined && !Array.isArray(data.components)) {
    throw new Error("Import file components must be an array when present.");
  }
  const includesTools = Object.prototype.hasOwnProperty.call(data, "tools");
  if (includesTools && !Array.isArray(data.tools)) {
    throw new Error("Import file tools must be an array when present.");
  }
  const toolValues = includesTools ? data.tools as unknown[] : [];
  const includesAdapters = Object.prototype.hasOwnProperty.call(data, "adapters");
  if (includesAdapters && !Array.isArray(data.adapters)) {
    throw new Error("Import file adapters must be an array when present.");
  }
  const adapterValues = includesAdapters ? data.adapters as unknown[] : [];
  const includesComponentBooks = Object.prototype.hasOwnProperty.call(data, "componentBooks");
  if (includesComponentBooks && !Array.isArray(data.componentBooks)) {
    throw new Error("Import file componentBooks must be an array when present.");
  }
  const componentBookValues = includesComponentBooks ? data.componentBooks as unknown[] : [];
  if (
    data.cases.length === 0 &&
    toolValues.length === 0 &&
    adapterValues.length === 0 &&
    componentBookValues.length === 0
  ) {
    throw new Error("Import file must contain at least one case, tool, adapter, or component book.");
  }

  const sourceCompartmentIds = new Set<number>();
  const preparedCases = data.cases.map((caseValue, caseIndex): PreparedImportCase => {
    const label = `Case ${caseIndex + 1}`;
    const caseData = importRecord(caseValue, label);
    const name = importRequiredText(caseData.name, `${label} name`);
    const model = caseData.model === undefined || caseData.model === null
      ? undefined
      : importRequiredText(caseData.model, `${label} model`);
    const modelDimensions = model?.match(/(\d+)x(\d+)/);
    const rows = caseData.rows === undefined || caseData.rows === null
      ? modelDimensions ? Number(modelDimensions[2]) : 6
      : importInteger(caseData.rows, `${label} rows`, 1, 26);
    const cols = caseData.cols === undefined || caseData.cols === null
      ? modelDimensions ? Number(modelDimensions[1]) : 4
      : importInteger(caseData.cols, `${label} columns`, 1, 24);
    importInteger(rows, `${label} rows`, 1, 26);
    importInteger(cols, `${label} columns`, 1, 24);

    if (caseData.hasBottom !== undefined && caseData.hasBottom !== null && typeof caseData.hasBottom !== "boolean") {
      throw new Error(`${label} hasBottom must be a boolean.`);
    }
    const hasBottom = caseData.hasBottom === true || Boolean(model?.includes("BOTH"));

    const closedImageUrl = importManagedUrl(
      caseData.closedImageUrl,
      IMPORT_CASE_IMAGE_PATTERN,
      `${label} closed image`,
    );
    const openImageUrl = importManagedUrl(
      caseData.openImageUrl,
      IMPORT_CASE_IMAGE_PATTERN,
      `${label} open image`,
    );
    const topModel3dUrl = importManagedUrl(
      caseData.topModel3dUrl,
      IMPORT_MODEL_PATTERN,
      `${label} top model`,
    );
    const bottomModel3dUrl = importManagedUrl(
      caseData.bottomModel3dUrl,
      IMPORT_MODEL_PATTERN,
      `${label} bottom model`,
    );
    const topModel3dName = importOptionalText(caseData.topModel3dName, `${label} top model name`, 200);
    const bottomModel3dName = importOptionalText(caseData.bottomModel3dName, `${label} bottom model name`, 200);
    const topModel3dSource = importModelSource(caseData.topModel3dSource, `${label} top model source`);
    const bottomModel3dSource = importModelSource(caseData.bottomModel3dSource, `${label} bottom model source`);

    if (!topModel3dUrl && (topModel3dName || topModel3dSource || caseData.topModel3dCalibration != null)) {
      throw new Error(`${label} has top-model metadata without a top GLB.`);
    }
    if (!bottomModel3dUrl && (bottomModel3dName || bottomModel3dSource || caseData.bottomModel3dCalibration != null)) {
      throw new Error(`${label} has bottom-model metadata without a bottom GLB.`);
    }
    const topModel3dCalibration = caseData.topModel3dCalibration == null
      ? null
      : parseCalibrationForModel(caseData.topModel3dCalibration, topModel3dUrl);
    const bottomModel3dCalibration = caseData.bottomModel3dCalibration == null
      ? null
      : parseCalibrationForModel(caseData.bottomModel3dCalibration, bottomModel3dUrl);
    if (caseData.topModel3dCalibration != null && !topModel3dCalibration) {
      throw new Error(`${label} top-model calibration is invalid or belongs to another GLB.`);
    }
    if (caseData.bottomModel3dCalibration != null && !bottomModel3dCalibration) {
      throw new Error(`${label} bottom-model calibration is invalid or belongs to another GLB.`);
    }

    let layoutGeometry: unknown = null;
    if (caseData.layoutGeometry != null) {
      if (!model?.startsWith("CUSTOM-")) {
        throw new Error(`${label} has custom geometry but is not a custom case.`);
      }
      try {
        layoutGeometry = parseCustomCaseLayout(caseData.layoutGeometry, { rows, cols, hasBottom });
      } catch {
        throw new Error(`${label} custom layout geometry does not match its rows, columns, and layers.`);
      }
    }

    if (!Array.isArray(caseData.compartments)) {
      throw new Error(`${label} compartments must be an array.`);
    }
    const caseLocators = new Set<string>();
    const compartments = caseData.compartments.map(
      (compartmentValue, compartmentIndex): PreparedImportCompartment => {
        const compartmentLabel = `${label} compartment ${compartmentIndex + 1}`;
        const compartment = importRecord(compartmentValue, compartmentLabel);
        const sourceId = importInteger(compartment.id, `${compartmentLabel} id`, 1);
        if (sourceCompartmentIds.has(sourceId)) {
          throw new Error(`${compartmentLabel} repeats compartment id ${sourceId}.`);
        }
        sourceCompartmentIds.add(sourceId);

        const position = importRequiredText(compartment.position, `${compartmentLabel} position`);
        const layer = compartment.layer === "bottom" ? "bottom" : compartment.layer === "top" ? "top" : null;
        if (!layer) throw new Error(`${compartmentLabel} layer must be "top" or "bottom".`);
        if (layer === "bottom" && !hasBottom) {
          throw new Error(`${compartmentLabel} is on a bottom layer that the case does not have.`);
        }
        importInteger(compartment.row, `${compartmentLabel} row`, 1, rows);
        importInteger(compartment.col, `${compartmentLabel} column`, 1, cols);

        const locator = `${layer}:${position}`;
        if (caseLocators.has(locator)) {
          throw new Error(`${label} repeats compartment ${position} on the ${layer} layer.`);
        }
        caseLocators.add(locator);
        return { sourceId, position, layer };
      },
    );

    return {
      name,
      compartments,
      payload: {
        name,
        ...(model ? { model } : {}),
        rows,
        cols,
        hasBottom,
        description: importOptionalText(caseData.description, `${label} description`),
        closedImageUrl,
        openImageUrl,
        topModel3dUrl,
        topModel3dName,
        topModel3dSource,
        topModel3dCalibration,
        bottomModel3dUrl,
        bottomModel3dName,
        bottomModel3dSource,
        bottomModel3dCalibration,
        layoutGeometry,
      },
    };
  });

  const occupiedSourceCompartments = new Set<number>();
  const preparedComponents = ((data.components as unknown[] | undefined) || []).map(
    (componentValue, componentIndex): PreparedImportComponent => {
      const label = `Component ${componentIndex + 1}`;
      const component = importRecord(componentValue, label);
      const name = importRequiredText(component.name, `${label} name`);
      const sourceCompartmentId = importInteger(component.compartmentId, `${label} compartmentId`, 1);
      if (!sourceCompartmentIds.has(sourceCompartmentId)) {
        throw new Error(`${label} references compartment ${sourceCompartmentId}, which is not in the imported cases.`);
      }
      if (occupiedSourceCompartments.has(sourceCompartmentId)) {
        throw new Error(`More than one imported component targets compartment ${sourceCompartmentId}.`);
      }
      occupiedSourceCompartments.add(sourceCompartmentId);

      let categoryId: number;
      if (component.categoryId !== undefined && component.categoryId !== null) {
        categoryId = importInteger(component.categoryId, `${label} categoryId`, 1);
      } else if (component.category !== undefined && component.category !== null) {
        const category = importRequiredText(component.category, `${label} category`).toLowerCase();
        categoryId = IMPORT_CATEGORY_IDS[category] ?? IMPORT_CATEGORY_IDS.other;
      } else {
        categoryId = IMPORT_CATEGORY_IDS.other;
      }

      const quantity = component.quantity === undefined || component.quantity === null
        ? 1
        : importInteger(component.quantity, `${label} quantity`, 0);
      const minQuantity = component.minQuantity === null
        ? null
        : component.minQuantity === undefined
          ? 5
          : importInteger(component.minQuantity, `${label} minimum quantity`, 1);
      const model3dUrl = importManagedUrl(component.model3dUrl, IMPORT_MODEL_PATTERN, `${label} model`);
      const model3dName = importOptionalText(component.model3dName, `${label} model name`, 200);
      const model3dSource = importModelSource(component.model3dSource, `${label} model source`);
      if (!model3dUrl && (model3dName || model3dSource)) {
        throw new Error(`${label} has model metadata without a GLB.`);
      }
      const model3dRotation = component.model3dRotation == null
        ? null
        : parseComponentModelRotationForModel(component.model3dRotation, model3dUrl);
      if (component.model3dRotation != null && !model3dRotation) {
        throw new Error(`${label} model rotation is invalid or belongs to another GLB.`);
      }

      return {
        name,
        sourceCompartmentId,
        payload: {
          name,
          categoryId,
          packageSize: importOptionalText(component.packageSize, `${label} package size`),
          quantity,
          minQuantity,
          datasheetUrl: importOptionalText(component.datasheetUrl, `${label} datasheet URL`),
          photoUrl: importOptionalText(component.photoUrl, `${label} photo URL`),
          model3dUrl,
          model3dName,
          model3dSource,
          model3dRotation,
          notes: importOptionalText(component.notes, `${label} notes`),
        },
      };
    },
  );

  const preparedTools = toolValues.map(
    (toolValue, toolIndex): PreparedImportTool => {
      const label = `Tool ${toolIndex + 1}`;
      const tool = importRecord(toolValue, label);
      const name = importRequiredText(tool.name, `${label} name`, 200);

      return {
        name,
        payload: {
          name,
          category: importRequiredText(tool.category, `${label} category`, 100),
          manufacturer: importOptionalText(tool.manufacturer, `${label} manufacturer`, 200),
          modelNumber: importOptionalText(tool.modelNumber, `${label} model number`, 200),
          productUrl: importOptionalText(tool.productUrl, `${label} product URL`, 2_000),
          imageUrl: importOptionalText(tool.imageUrl, `${label} image URL`, 2_000),
          quantity: tool.quantity === undefined || tool.quantity === null
            ? 1
            : importInteger(tool.quantity, `${label} quantity`, 1),
          location: importOptionalText(tool.location, `${label} location`, 300),
          capabilities: importOptionalText(tool.capabilities, `${label} capabilities`, 4_000),
          notes: importOptionalText(tool.notes, `${label} notes`, 4_000),
        },
      };
    },
  );

  const preparedAdapters = adapterValues.map(
    (adapterValue, adapterIndex): PreparedImportAdapter => {
      const label = `Adapter ${adapterIndex + 1}`;
      const adapter = importRecord(adapterValue, label);
      const name = importRequiredText(adapter.name, `${label} name`, 200);
      const endpointA = importOptionalText(adapter.endpointA, `${label} endpoint A`, 200);
      const endpointB = importOptionalText(adapter.endpointB, `${label} endpoint B`, 200);
      const endpointAType = importAdapterEndpointType(
        adapter.endpointAType,
        `${label} endpoint A type`,
      );
      const endpointBType = importAdapterEndpointType(
        adapter.endpointBType,
        `${label} endpoint B type`,
      );
      if (Boolean(endpointA) !== Boolean(endpointB)) {
        throw new Error(`${label} endpoint A and endpoint B must either both be provided or both be blank.`);
      }
      if (!endpointA && (endpointAType || endpointBType)) {
        throw new Error(`${label} endpoint icon types require both endpoint labels.`);
      }

      return {
        name,
        payload: {
          name,
          category: importRequiredText(adapter.category, `${label} category`, 100),
          manufacturer: importOptionalText(adapter.manufacturer, `${label} manufacturer`, 200),
          modelNumber: importOptionalText(adapter.modelNumber, `${label} model number`, 200),
          productUrl: importOptionalText(adapter.productUrl, `${label} product URL`, 2_000),
          imageUrl: importOptionalText(adapter.imageUrl, `${label} image URL`, 2_000),
          endpointA,
          endpointAType,
          endpointB,
          endpointBType,
          quantity: adapter.quantity === undefined || adapter.quantity === null
            ? 1
            : importInteger(adapter.quantity, `${label} quantity`, 1),
          location: importOptionalText(adapter.location, `${label} location`, 300),
          compatibility: importOptionalText(adapter.compatibility, `${label} compatibility`, 4_000),
          notes: importOptionalText(adapter.notes, `${label} notes`, 4_000),
        },
      };
    },
  );

  const preparedComponentBooks = componentBookValues.map(
    (bookValue, bookIndex): PreparedImportBook => {
      const label = `Component book ${bookIndex + 1}`;
      const book = importRecord(bookValue, label);
      const name = importRequiredText(book.name, `${label} name`, 200);
      if (!Array.isArray(book.items)) {
        throw new Error(`${label} items must be an array.`);
      }

      const items = book.items.map((itemValue, itemIndex): PreparedImportBookItem => {
        const itemLabel = `${label} item ${itemIndex + 1}`;
        const item = importRecord(itemValue, itemLabel);
        const itemName = importRequiredText(item.name, `${itemLabel} name`, 200);
        return {
          name: itemName,
          payload: {
            name: itemName,
            category: importOptionalText(item.category, `${itemLabel} category`, 100),
            partNumber: importOptionalText(item.partNumber, `${itemLabel} part number`, 200),
            value: importOptionalText(item.value, `${itemLabel} value`, 200),
            packageSize: importOptionalText(item.packageSize, `${itemLabel} package size`, 100),
            quantity: item.quantity === undefined || item.quantity === null
              ? null
              : importInteger(item.quantity, `${itemLabel} quantity`, 0),
            notes: importOptionalText(item.notes, `${itemLabel} notes`, 4_000),
          },
        };
      });

      return {
        name,
        payload: {
          name,
          manufacturer: importOptionalText(book.manufacturer, `${label} manufacturer`, 200),
          packageSize: importOptionalText(book.packageSize, `${label} package size`, 100),
          productUrl: importOptionalText(book.productUrl, `${label} product URL`, 2_000),
          imageUrl: importOptionalText(book.imageUrl, `${label} image URL`, 2_000),
          description: importOptionalText(book.description, `${label} description`, 4_000),
          notes: importOptionalText(book.notes, `${label} notes`, 4_000),
        },
        items,
      };
    },
  );

  return {
    cases: preparedCases,
    components: preparedComponents,
    tools: preparedTools,
    adapters: preparedAdapters,
    componentBooks: preparedComponentBooks,
    includesTools,
    includesAdapters,
    includesComponentBooks,
  };
}

async function importResponseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { message?: unknown };
    return typeof body.message === "string" && body.message ? body.message : fallback;
  } catch {
    return fallback;
  }
}

async function importJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw new Error(await importResponseError(response, fallback));
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`${fallback}: the server returned an invalid response.`);
  }
}

async function verifyPreparedImportAssets(preparedImport: PreparedCatalogImport) {
  const urls = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("/uploads/")) urls.add(value);
  };

  for (const preparedCase of preparedImport.cases) {
    collect(preparedCase.payload.closedImageUrl);
    collect(preparedCase.payload.openImageUrl);
    collect(preparedCase.payload.topModel3dUrl);
    collect(preparedCase.payload.bottomModel3dUrl);
  }
  for (const preparedComponent of preparedImport.components) {
    collect(preparedComponent.payload.photoUrl);
    collect(preparedComponent.payload.model3dUrl);
  }
  for (const preparedTool of preparedImport.tools) {
    collect(preparedTool.payload.imageUrl);
  }
  for (const preparedAdapter of preparedImport.adapters) {
    collect(preparedAdapter.payload.imageUrl);
  }
  for (const preparedBook of preparedImport.componentBooks) {
    collect(preparedBook.payload.imageUrl);
  }

  const missing: string[] = [];
  await Promise.all(Array.from(urls, async url => {
    try {
      const response = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (!response.ok) missing.push(url);
    } catch {
      missing.push(url);
    }
  }));

  if (missing.length > 0) {
    missing.sort();
    const preview = missing.slice(0, 5).join(", ");
    const remainder = missing.length > 5 ? ` and ${missing.length - 5} more` : "";
    throw new Error(
      `Import references ${missing.length} missing upload file(s): ${preview}${remainder}. ` +
      "Restore the exported uploads folder, then try the import again.",
    );
  }
}

export default function Dashboard() {
  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("view");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("grid");
  const [copiedComponent, setCopiedComponent] = useState<Component | null>(null);
  const [editingComponent, setEditingComponent] = useState<{
    component?: Component;
    compartment: Compartment;
  } | null>(null);
  const [viewingComponent, setViewingComponent] = useState<{
    component: Component;
    compartment: Compartment;
  } | null>(null);
  const [showAddCase, setShowAddCase] = useState(false);
  const [imageCase, setImageCase] = useState<Case | null>(null);
  const [layoutCase, setLayoutCase] = useState<CaseWithCompartments | null>(null);
  const [showImportGuide, setShowImportGuide] = useState(false);
  const [showBomLocator, setShowBomLocator] = useState(false);
  const [showKicadSettings, setShowKicadSettings] = useState(false);
  const [showToolEditor, setShowToolEditor] = useState(false);
  const [editingTool, setEditingTool] = useState<Tool | null>(null);
  const [showAdapterEditor, setShowAdapterEditor] = useState(false);
  const [editingAdapter, setEditingAdapter] = useState<Adapter | null>(null);
  const [showRenameCase, setShowRenameCase] = useState(false);
  const [renameCaseName, setRenameCaseName] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const last3dLayerByCaseRef = useRef(new Map<number, CaseModelLayer>());
  const pending2dLayerScrollRef = useRef<Pending2dLayerScroll | null>(null);
  const [, setLocation] = useLocation();
  const [isToolsRoute] = useRoute("/tools");
  const [isAdaptersRoute] = useRoute("/adapters");
  const [isBooksRoute] = useRoute("/books");
  const locationSearch = useSearch();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isToolsView = isToolsRoute;
  const isAdaptersView = isAdaptersRoute;
  const isBooksView = isBooksRoute;

  const invalidateCatalogQueries = () => queryClient.invalidateQueries({
    predicate: query => {
      const root = query.queryKey[0];
      return typeof root === "string" && (
        root.startsWith("/api/cases") ||
        root.startsWith("/api/components") ||
        root.startsWith("/api/tools") ||
        root.startsWith("/api/adapters") ||
        root.startsWith("/api/component-books") ||
        root.startsWith("/api/component-book-items")
      );
    },
  });

  // Fetch all cases
  const { data: cases = [] } = useQuery<Case[]>({
    queryKey: ["/api/cases"],
  });

  const orderedCases = useMemo(() => {
    return [...cases].sort((left, right) => {
      if (left.model === UNSORTED_CASE_MODEL) return -1;
      if (right.model === UNSORTED_CASE_MODEL) return 1;
      return left.sortOrder - right.sortOrder || left.id - right.id;
    });
  }, [cases]);

  const libraryCases = useMemo(
    () => orderedCases.filter(case_ => case_.model !== UNSORTED_CASE_MODEL),
    [orderedCases],
  );

  const requestedCaseId = useMemo(() => {
    if (isToolsView || isAdaptersView || isBooksView) return null;
    return parsePositiveInteger(new URLSearchParams(locationSearch).get("case"));
  }, [isAdaptersView, isBooksView, isToolsView, locationSearch]);

  const requestedSearch = useMemo(
    () => new URLSearchParams(locationSearch).get("search")?.trim() || "",
    [locationSearch],
  );

  const requestedDisplayMode = useMemo<DisplayMode>(() => {
    const value = new URLSearchParams(locationSearch).get("view") as DisplayMode | null;
    return value && DISPLAY_MODES.has(value) ? value : "grid";
  }, [locationSearch]);

  const requestedLayer = useMemo<CaseModelLayer>(() => {
    return new URLSearchParams(locationSearch).get("layer") === "bottom" ? "bottom" : "top";
  }, [locationSearch]);

  const requestedComponentId = useMemo(() => {
    return parsePositiveInteger(new URLSearchParams(locationSearch).get("component"));
  }, [locationSearch]);

  // Layer and component are intentionally absent from 2D URLs. Keep the last
  // explicit 3D layer per case so returning to 3D can restore the same half.
  useEffect(() => {
    if (requestedCaseId === null || requestedDisplayMode !== "case3d") return;
    last3dLayerByCaseRef.current.set(requestedCaseId, requestedLayer);
  }, [requestedCaseId, requestedDisplayMode, requestedLayer]);

  const updateDashboardRoute = (
    updates: Partial<Record<"case" | "view" | "layer" | "component" | "search", string | number | null>>,
  ) => {
    const params = new URLSearchParams(locationSearch);

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined || value === "") {
        params.delete(key);
      } else {
        params.set(key, String(value));
      }
    }

    const query = params.toString();
    setLocation(query ? `/?${query}` : "/");
  };

  // The route is the source of truth: no case query means the visual Case Library.
  useEffect(() => {
    const nextCaseId = requestedCaseId !== null && orderedCases.some(case_ => case_.id === requestedCaseId)
      ? requestedCaseId
      : null;
    setSelectedCaseId(current => current === nextCaseId ? current : nextCaseId);
  }, [orderedCases, requestedCaseId]);

  useEffect(() => {
    setSearchQuery(requestedSearch);
  }, [requestedSearch]);

  useEffect(() => {
    const nextDisplayMode = requestedCaseId === null ? "grid" : requestedDisplayMode;
    setDisplayMode(nextDisplayMode);
    if (nextDisplayMode === "case3d") setInteractionMode("view");
  }, [requestedCaseId, requestedDisplayMode]);

  // Fetch selected case with compartments
  const { data: selectedCase, isLoading } = useQuery<CaseWithCompartments>({
    queryKey: ["/api/cases", requestedCaseId],
    queryFn: async () => {
      if (!requestedCaseId) throw new Error("A case is required");
      const response = await fetch(`/api/cases/${requestedCaseId}`);
      if (!response.ok) throw new Error('Failed to fetch case');
      return response.json();
    },
    enabled: !!requestedCaseId,
    retry: 3,
  });

  // The 2D views expose stable layer markers. Scroll only for a direct mode
  // transition from 3D so browser-history and ordinary deep-link navigation
  // retain their existing scroll behavior.
  useEffect(() => {
    const pending = pending2dLayerScrollRef.current;
    if (!pending || displayMode === "case3d" || selectedCase?.id !== pending.caseId) return;

    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-case-id="${pending.caseId}"][data-case-layer="${pending.layer}"]`,
      );
      const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      target?.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
      if (pending2dLayerScrollRef.current === pending) {
        pending2dLayerScrollRef.current = null;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [displayMode, selectedCase]);

  // Keep deep links internally consistent once the requested case has loaded.
  // Reading by requestedCaseId above avoids briefly pairing a browser-history URL
  // with the previously selected case while the sidebar state catches up.
  useEffect(() => {
    if (!selectedCase || selectedCase.id !== requestedCaseId) return;

    const params = new URLSearchParams(locationSearch);
    let changed = false;

    if (requestedDisplayMode !== "case3d") {
      for (const key of ["layer", "component"] as const) {
        if (params.has(key)) {
          params.delete(key);
          changed = true;
        }
      }
    } else if (requestedComponentId !== null) {
      const compartment = selectedCase.compartments.find(
        candidate => candidate.component?.id === requestedComponentId,
      );

      if (!compartment) {
        params.delete("component");
        changed = true;
      } else {
        const componentLayer: CaseModelLayer = compartment.layer === "bottom" ? "bottom" : "top";
        if (componentLayer !== requestedLayer) {
          params.set("layer", componentLayer);
          changed = true;
        }
      }
    }

    if (!changed) return;
    const query = params.toString();
    setLocation(query ? `/?${query}` : "/", { replace: true });
  }, [
    locationSearch,
    requestedCaseId,
    requestedComponentId,
    requestedDisplayMode,
    requestedLayer,
    selectedCase,
    setLocation,
  ]);

  // Search components
  const { data: searchResults = [] } = useQuery<Component[]>({
    queryKey: ["/api/components/search", searchQuery],
    queryFn: async () => {
      const response = await fetch(`/api/components/search?q=${encodeURIComponent(searchQuery.trim())}`);
      if (!response.ok) throw new Error("Failed to search components");
      return response.json();
    },
    enabled: searchQuery.length > 2,
  });

  const searchResultIds = useMemo(
    () => searchResults.map(component => component.id),
    [searchResults],
  );

  const pasteCompartmentMutation = useMutation({
    mutationFn: async ({
      source,
      targetCompartment,
      targetComponent,
    }: {
      source: Component;
      targetCompartment: Compartment;
      targetComponent?: Component;
    }) => {
      const payload = {
        name: source.name,
        compartmentId: targetCompartment.id,
        categoryId: source.categoryId,
        packageSize: source.packageSize,
        quantity: source.quantity,
        minQuantity: source.minQuantity,
        datasheetUrl: source.datasheetUrl,
        photoUrl: source.photoUrl,
        model3dUrl: source.model3dUrl,
        model3dName: source.model3dName,
        model3dSource: source.model3dSource,
        model3dRotation: source.model3dRotation,
        notes: source.notes,
      };

      const response = targetComponent
        ? await apiRequest("PATCH", `/api/components/${targetComponent.id}`, payload)
        : await apiRequest("POST", "/api/components", payload);

      return response.json();
    },
    onSuccess: (_component, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      toast({
        title: "Compartment pasted",
        description: `${variables.source.name} copied to ${variables.targetCompartment.layer} ${variables.targetCompartment.position}.`,
      });
    },
    onError: (error) => {
      toast({
        title: "Paste failed",
        description: error instanceof Error ? error.message : "The copied compartment could not be pasted.",
        variant: "destructive",
      });
    },
  });

  const renameCaseMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const response = await apiRequest("PATCH", `/api/cases/${id}`, { name });
      return response.json();
    },
    onSuccess: (updatedCase: Case) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cases", updatedCase.id] });
      toast({
        title: "Case renamed",
        description: `Updated to ${updatedCase.name}.`,
      });
      setShowRenameCase(false);
    },
    onError: (error) => {
      toast({
        title: "Rename failed",
        description: error instanceof Error ? error.message : "The case name could not be updated.",
        variant: "destructive",
      });
    },
  });

  const reorderCasesMutation = useMutation({
    mutationFn: async (caseIds: number[]) => {
      const response = await apiRequest("PATCH", "/api/cases/reorder", { caseIds });
      return response.json() as Promise<Case[]>;
    },
    onSuccess: (updatedCases) => {
      queryClient.setQueryData(["/api/cases"], updatedCases);
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
    },
    onError: (error) => {
      toast({
        title: "Reorder failed",
        description: error instanceof Error ? error.message : "The case order could not be saved.",
        variant: "destructive",
      });
    },
  });

  const deleteCaseMutation = useMutation({
    mutationFn: async (case_: Case) => {
      await apiRequest("DELETE", `/api/cases/${case_.id}`);
      return case_;
    },
    onSuccess: (deletedCase) => {
      queryClient.removeQueries({ queryKey: ["/api/cases", deletedCase.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });

      if (selectedCaseId === deletedCase.id) {
        setSelectedCaseId(null);
        setLocation("/");
      }

      if (imageCase?.id === deletedCase.id) setImageCase(null);
      if (layoutCase?.id === deletedCase.id) setLayoutCase(null);

      toast({
        title: "Case deleted",
        description: `Deleted ${deletedCase.name}.`,
      });
    },
    onError: (error) => {
      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "The case could not be deleted.",
        variant: "destructive",
      });
    },
  });

  const handleCompartmentClick = (compartment: Compartment, component?: Component) => {
    if (interactionMode === "edit") {
      setEditingComponent({ compartment, component });
      return;
    }

    if (component) {
      setViewingComponent({ compartment, component });
    }
  };

  const handleDisplayModeChange = (nextMode: DisplayMode) => {
    const caseId = selectedCase?.id ?? requestedCaseId;

    if (caseId !== null && displayMode === "case3d") {
      last3dLayerByCaseRef.current.set(caseId, requestedLayer);
      if (nextMode !== "case3d") {
        pending2dLayerScrollRef.current = { caseId, layer: requestedLayer };
      }
    }

    const next3dLayer = caseId === null
      ? requestedLayer
      : last3dLayerByCaseRef.current.get(caseId) ?? requestedLayer;

    setDisplayMode(nextMode);
    if (nextMode === "case3d") setInteractionMode("view");
    updateDashboardRoute({
      view: nextMode === "grid" ? null : nextMode,
      layer: nextMode === "case3d" ? next3dLayer : null,
      component: nextMode === "case3d" ? requestedComponentId : null,
      search: searchQuery.trim() || null,
    });
  };

  const handleInteractionModeChange = (nextMode: InteractionMode) => {
    setInteractionMode(nextMode);
    if (nextMode === "edit" && displayMode === "case3d") {
      handleDisplayModeChange("grid");
    }
  };

  const handle3dLayerChange = (layer: CaseModelLayer) => {
    const selectedCompartment = selectedCase?.compartments.find(
      compartment => compartment.component?.id === requestedComponentId,
    );

    updateDashboardRoute({
      view: "case3d",
      layer,
      component: selectedCompartment?.layer === layer ? requestedComponentId : null,
      search: searchQuery.trim() || null,
    });
  };

  const handle3dSelectCompartment = (compartmentId: number | null) => {
    const compartment = compartmentId === null
      ? null
      : selectedCase?.compartments.find(candidate => candidate.id === compartmentId) || null;

    updateDashboardRoute({
      view: "case3d",
      layer: resolveCompartmentSceneLayer(compartment?.layer, requestedLayer),
      component: compartment?.component?.id || null,
      search: searchQuery.trim() || null,
    });
  };

  const handle3dOpenComponent = (componentId: number) => {
    const compartment = selectedCase?.compartments.find(
      candidate => candidate.component?.id === componentId,
    );
    if (!compartment?.component) return;

    updateDashboardRoute({
      view: "case3d",
      layer: compartment.layer === "bottom" ? "bottom" : "top",
      component: componentId,
      search: searchQuery.trim() || null,
    });
    setViewingComponent({ compartment, component: compartment.component });
  };

  const handle3dFailure = (error: Error) => {
    toast({
      title: "3D view unavailable",
      description: `${error.message || "The scene could not be displayed."} Switched back to the grid.`,
      variant: "destructive",
    });
    handleDisplayModeChange("grid");
  };

  const handleCopyCompartment = (component: Component) => {
    setCopiedComponent(component);
    toast({
      title: "Compartment copied",
      description: `${component.name} is ready to paste.`,
    });
  };

  const handlePasteCompartment = (compartment: Compartment, component?: Component) => {
    if (!copiedComponent) {
      toast({
        title: "Nothing copied",
        description: "Copy a populated compartment first.",
        variant: "destructive",
      });
      return;
    }

    if (component?.id === copiedComponent.id) {
      toast({
        title: "Already here",
        description: "Choose a different compartment to paste into.",
      });
      return;
    }

    if (component && !confirm(`Replace ${component.name} with ${copiedComponent.name}?`)) {
      return;
    }

    pasteCompartmentMutation.mutate({
      source: copiedComponent,
      targetCompartment: compartment,
      targetComponent: component,
    });
  };

  const handleCaseSelect = (caseId: number) => {
    setSelectedCaseId(caseId);
    setSearchQuery("");
    setLocation(`/?case=${caseId}`);
  };

  const handleShowLibrary = () => {
    setSelectedCaseId(null);
    setSearchQuery("");
    setLocation("/");
  };

  const handleShowTools = () => {
    setSelectedCaseId(null);
    setSearchQuery("");
    setLocation("/tools");
  };

  const handleShowAdapters = () => {
    setSelectedCaseId(null);
    setSearchQuery("");
    setLocation("/adapters");
  };

  const handleShowBooks = () => {
    setSelectedCaseId(null);
    setSearchQuery("");
    setLocation("/books");
  };

  const handleAddTool = () => {
    setEditingTool(null);
    setShowToolEditor(true);
  };

  const handleEditTool = (tool: Tool) => {
    setEditingTool(tool);
    setShowToolEditor(true);
  };

  const closeToolEditor = () => {
    setShowToolEditor(false);
    setEditingTool(null);
  };

  const handleAddAdapter = () => {
    setEditingAdapter(null);
    setShowAdapterEditor(true);
  };

  const handleEditAdapter = (adapter: Adapter) => {
    setEditingAdapter(adapter);
    setShowAdapterEditor(true);
  };

  const closeAdapterEditor = () => {
    setShowAdapterEditor(false);
    setEditingAdapter(null);
  };

  const handleCaseReorder = (caseIds: number[]) => {
    if (reorderCasesMutation.isPending) return;
    reorderCasesMutation.mutate(caseIds);
  };

  const openRenameCase = () => {
    if (!selectedCase) return;
    setRenameCaseName(selectedCase.name);
    setShowRenameCase(true);
  };

  const submitRenameCase = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!selectedCase) return;

    const nextName = renameCaseName.trim();
    if (!nextName) {
      toast({
        title: "Name required",
        description: "Enter a case name before saving.",
        variant: "destructive",
      });
      return;
    }

    if (nextName === selectedCase.name) {
      setShowRenameCase(false);
      return;
    }

    renameCaseMutation.mutate({
      id: selectedCase.id,
      name: nextName,
    });
  };

  const exportData = async () => {
    try {
      const [casesResponse, componentsResponse, toolsResponse, adaptersResponse, componentBooksResponse] = await Promise.all([
        fetch('/api/cases'),
        fetch('/api/components'),
        fetch('/api/tools'),
        fetch('/api/adapters'),
        fetch('/api/component-books'),
      ]);
      const [allCases, allComponents, allTools, allAdapters, allComponentBooks] = await Promise.all([
        importJson<Case[]>(casesResponse, "Could not export cases"),
        importJson<Component[]>(componentsResponse, "Could not export components"),
        importJson<Tool[]>(toolsResponse, "Could not export tools"),
        importJson<Adapter[]>(adaptersResponse, "Could not export adapters"),
        importJson<ComponentBookWithItems[]>(componentBooksResponse, "Could not export component books"),
      ]);

      // Get all cases with their compartments for proper import mapping
      const casesWithCompartments = [];
      for (const case_ of allCases) {
        const caseResponse = await fetch(`/api/cases/${case_.id}`);
        const caseWithCompartments = await importJson<CaseWithCompartments>(
          caseResponse,
          `Could not export case "${case_.name}"`,
        );
        casesWithCompartments.push(caseWithCompartments);
      }

      // Transform cases to match import format expectations
      const transformedCases = casesWithCompartments.map(case_ => ({
        ...case_,
        rows: case_.rows,
        cols: case_.cols,
        hasBottom: Boolean(case_.hasBottom),
        // Remove components from compartments to avoid duplication - they're in the separate components array
        compartments: case_.compartments?.map((comp: Compartment) => ({
          id: comp.id,
          caseId: comp.caseId,
          position: comp.position,
          row: comp.row,
          col: comp.col,
          layer: comp.layer
        })) || []
      }));

      const exportData = {
        cases: transformedCases,
        components: allComponents,
        tools: allTools,
        adapters: allAdapters,
        componentBooks: allComponentBooks,
        exportDate: new Date().toISOString(),
        version: "8.0"
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `smd-components-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "The catalog backup could not be created.",
        variant: "destructive",
      });
    }
  };

  const importData = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const stagedCaseIds: number[] = [];
      const stagedToolIds: number[] = [];
      const stagedAdapterIds: number[] = [];
      const stagedComponentBookIds: number[] = [];
      try {
        // Fully parse and validate the file before any request can mutate the catalog.
        const preparedImport = prepareCatalogImport(JSON.parse(await file.text()));
        await verifyPreparedImportAssets(preparedImport);

        // Ask user about overwrite preference
        const importedDataLabel = [
          "cases and components",
          preparedImport.includesTools ? "tools" : null,
          preparedImport.includesAdapters ? "adapters" : null,
          preparedImport.includesComponentBooks ? "component books" : null,
        ].filter(Boolean).join(", ");
        const shouldOverwrite = confirm(
          'Would you like to overwrite existing data?\n\n' +
          `OK = Replace existing ${importedDataLabel}\n` +
          'Cancel = Add as new (imported) items'
        );

        let existingSnapshot: {
          cases: Case[];
          components: Component[];
          tools: Tool[];
          adapters: Adapter[];
          componentBooks: ComponentBookWithItems[];
        } = {
          cases: [],
          components: [],
          tools: [],
          adapters: [],
          componentBooks: [],
        };
        if (shouldOverwrite) {
          const [casesResponse, componentsResponse] = await Promise.all([
            fetch('/api/cases'),
            fetch('/api/components'),
          ]);
          existingSnapshot = {
            cases: await importJson<Case[]>(casesResponse, "Could not snapshot the existing cases"),
            components: await importJson<Component[]>(componentsResponse, "Could not snapshot the existing components"),
            tools: [],
            adapters: [],
            componentBooks: [],
          };
          if (preparedImport.includesTools) {
            const toolsResponse = await fetch('/api/tools');
            existingSnapshot.tools = await importJson<Tool[]>(
              toolsResponse,
              "Could not snapshot the existing tools",
            );
          }
          if (preparedImport.includesAdapters) {
            const adaptersResponse = await fetch('/api/adapters');
            existingSnapshot.adapters = await importJson<Adapter[]>(
              adaptersResponse,
              "Could not snapshot the existing adapters",
            );
          }
          if (preparedImport.includesComponentBooks) {
            const booksResponse = await fetch('/api/component-books');
            existingSnapshot.componentBooks = await importJson<ComponentBookWithItems[]>(
              booksResponse,
              "Could not snapshot the existing component books",
            );
          }
        }

        const compartmentIdMapping = new Map<number, number>();

        try {
          // Stage every new case while all old case, component, image, and GLB references remain live.
          for (const preparedCase of preparedImport.cases) {
            const caseResponse = await fetch('/api/cases', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...preparedCase.payload,
                name: shouldOverwrite ? preparedCase.name : `${preparedCase.name} (imported)`,
              }),
            });
            const newCase = await importJson<Case>(
              caseResponse,
              `Could not create case "${preparedCase.name}"`,
            );
            stagedCaseIds.push(newCase.id);

            const detailsResponse = await fetch(`/api/cases/${newCase.id}`);
            const caseWithCompartments = await importJson<CaseWithCompartments>(
              detailsResponse,
              `Could not verify compartments for "${preparedCase.name}"`,
            );
            const targetCompartments = new Map(
              caseWithCompartments.compartments.map(compartment => [
                `${compartment.layer === "bottom" ? "bottom" : "top"}:${compartment.position}`,
                compartment.id,
              ]),
            );

            for (const sourceCompartment of preparedCase.compartments) {
              const targetId = targetCompartments.get(
                `${sourceCompartment.layer}:${sourceCompartment.position}`,
              );
              if (!targetId) {
                throw new Error(
                  `Case "${preparedCase.name}" did not create ${sourceCompartment.layer} compartment ${sourceCompartment.position}.`,
                );
              }
              compartmentIdMapping.set(sourceCompartment.sourceId, targetId);
            }
          }

          // A staged case owns all compartment IDs, so component creation is also reversible
          // by deleting the staged case if any later request fails.
          for (const preparedComponent of preparedImport.components) {
            const targetCompartmentId = compartmentIdMapping.get(preparedComponent.sourceCompartmentId);
            if (!targetCompartmentId) {
              throw new Error(
                `No staged compartment exists for component "${preparedComponent.name}".`,
              );
            }

            const componentResponse = await fetch('/api/components', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...preparedComponent.payload,
                compartmentId: targetCompartmentId,
              }),
            });
            await importJson<Component>(
              componentResponse,
              `Could not create component "${preparedComponent.name}"`,
            );
          }

          for (const preparedTool of preparedImport.tools) {
            const toolResponse = await fetch('/api/tools', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...preparedTool.payload,
                name: shouldOverwrite ? preparedTool.name : importedCopyName(preparedTool.name, 200),
              }),
            });
            const newTool = await importJson<Tool>(
              toolResponse,
              `Could not create tool "${preparedTool.name}"`,
            );
            stagedToolIds.push(newTool.id);
          }

          for (const preparedAdapter of preparedImport.adapters) {
            const adapterResponse = await fetch('/api/adapters', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...preparedAdapter.payload,
                name: shouldOverwrite
                  ? preparedAdapter.name
                  : importedCopyName(preparedAdapter.name, 200),
              }),
            });
            const newAdapter = await importJson<Adapter>(
              adapterResponse,
              `Could not create adapter "${preparedAdapter.name}"`,
            );
            stagedAdapterIds.push(newAdapter.id);
          }

          for (const preparedBook of preparedImport.componentBooks) {
            const bookResponse = await fetch('/api/component-books', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...preparedBook.payload,
                name: shouldOverwrite ? preparedBook.name : importedCopyName(preparedBook.name, 200),
              }),
            });
            const newBook = await importJson<ComponentBook>(
              bookResponse,
              `Could not create component book "${preparedBook.name}"`,
            );
            stagedComponentBookIds.push(newBook.id);

            for (const preparedItem of preparedBook.items) {
              const itemResponse = await fetch(`/api/component-books/${newBook.id}/items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(preparedItem.payload),
              });
              await importJson<ComponentBookItem>(
                itemResponse,
                `Could not create "${preparedItem.name}" in component book "${preparedBook.name}"`,
              );
            }
          }
        } catch (stagingError) {
          const rollbackFailures: string[] = [];
          for (const bookId of [...stagedComponentBookIds].reverse()) {
            try {
              const response = await fetch(`/api/component-books/${bookId}`, { method: 'DELETE' });
              if (!response.ok && response.status !== 404) rollbackFailures.push(`component book ${bookId}`);
            } catch {
              rollbackFailures.push(`component book ${bookId}`);
            }
          }
          for (const adapterId of [...stagedAdapterIds].reverse()) {
            try {
              const response = await fetch(`/api/adapters/${adapterId}`, { method: 'DELETE' });
              if (!response.ok && response.status !== 404) rollbackFailures.push(`adapter ${adapterId}`);
            } catch {
              rollbackFailures.push(`adapter ${adapterId}`);
            }
          }
          for (const toolId of [...stagedToolIds].reverse()) {
            try {
              const response = await fetch(`/api/tools/${toolId}`, { method: 'DELETE' });
              if (!response.ok && response.status !== 404) rollbackFailures.push(`tool ${toolId}`);
            } catch {
              rollbackFailures.push(`tool ${toolId}`);
            }
          }
          for (const caseId of [...stagedCaseIds].reverse()) {
            try {
              const response = await fetch(`/api/cases/${caseId}`, { method: 'DELETE' });
              if (!response.ok && response.status !== 404) rollbackFailures.push(`case ${caseId}`);
            } catch {
              rollbackFailures.push(`case ${caseId}`);
            }
          }

          const reason = stagingError instanceof Error ? stagingError.message : "Unknown staging error";
          const rollbackMessage = rollbackFailures.length === 0
            ? "All identified staged records were rolled back. The catalog was refreshed in case a request completed without returning its ID."
            : `${rollbackFailures.length} staged record(s) could not be rolled back; the existing catalog is still intact.`;
          throw new Error(`Import stopped before the existing catalog was changed: ${reason} ${rollbackMessage}`);
        }

        const cleanupFailures: Array<{ id: number; name: string }> = [];
        const toolCleanupFailures: Array<{ id: number; name: string }> = [];
        const adapterCleanupFailures: Array<{ id: number; name: string }> = [];
        const componentBookCleanupFailures: Array<{ id: number; name: string }> = [];
        if (shouldOverwrite) {
          // Old components are deleted by the case cascade only after the complete staged
          // catalog references the same media, so shared image/GLB cleanup remains safe.
          for (const existingCase of existingSnapshot.cases) {
            try {
              const response = await fetch(`/api/cases/${existingCase.id}`, { method: 'DELETE' });
              if (!response.ok && response.status !== 404) {
                cleanupFailures.push({ id: existingCase.id, name: existingCase.name });
              }
            } catch {
              cleanupFailures.push({ id: existingCase.id, name: existingCase.name });
            }
          }

          if (preparedImport.includesTools) {
            for (const existingTool of existingSnapshot.tools) {
              try {
                const response = await fetch(`/api/tools/${existingTool.id}`, { method: 'DELETE' });
                if (!response.ok && response.status !== 404) {
                  toolCleanupFailures.push({ id: existingTool.id, name: existingTool.name });
                }
              } catch {
                toolCleanupFailures.push({ id: existingTool.id, name: existingTool.name });
              }
            }
          }

          if (preparedImport.includesAdapters) {
            for (const existingAdapter of existingSnapshot.adapters) {
              try {
                const response = await fetch(`/api/adapters/${existingAdapter.id}`, { method: 'DELETE' });
                if (!response.ok && response.status !== 404) {
                  adapterCleanupFailures.push({ id: existingAdapter.id, name: existingAdapter.name });
                }
              } catch {
                adapterCleanupFailures.push({ id: existingAdapter.id, name: existingAdapter.name });
              }
            }
          }

          if (preparedImport.includesComponentBooks) {
            for (const existingBook of existingSnapshot.componentBooks) {
              try {
                const response = await fetch(`/api/component-books/${existingBook.id}`, { method: 'DELETE' });
                if (!response.ok && response.status !== 404) {
                  componentBookCleanupFailures.push({ id: existingBook.id, name: existingBook.name });
                }
              } catch {
                componentBookCleanupFailures.push({ id: existingBook.id, name: existingBook.name });
              }
            }
          }
        }

        await invalidateCatalogQueries();

        if (shouldOverwrite) setLocation("/", { replace: true });

        if (
          cleanupFailures.length > 0 ||
          toolCleanupFailures.length > 0 ||
          adapterCleanupFailures.length > 0 ||
          componentBookCleanupFailures.length > 0
        ) {
          const failureSummary = [
            cleanupFailures.length > 0
              ? `${cleanupFailures.length} old case${cleanupFailures.length === 1 ? "" : "s"}`
              : null,
            toolCleanupFailures.length > 0
              ? `${toolCleanupFailures.length} old tool${toolCleanupFailures.length === 1 ? "" : "s"}`
              : null,
            adapterCleanupFailures.length > 0
              ? `${adapterCleanupFailures.length} old adapter${adapterCleanupFailures.length === 1 ? "" : "s"}`
              : null,
            componentBookCleanupFailures.length > 0
              ? `${componentBookCleanupFailures.length} old component book${componentBookCleanupFailures.length === 1 ? "" : "s"}`
              : null,
          ].filter(Boolean).join(" and ");
          alert(
            `Import completed, but ${failureSummary} could not be removed. ` +
            'The complete imported catalog is available; remove the duplicate old records manually.'
          );
        } else if (shouldOverwrite) {
          const replacedSummary = [
            `${existingSnapshot.cases.length} cases`,
            `${existingSnapshot.components.length} components`,
            preparedImport.includesTools ? `${existingSnapshot.tools.length} tools` : null,
            preparedImport.includesAdapters ? `${existingSnapshot.adapters.length} adapters` : null,
            preparedImport.includesComponentBooks
              ? `${existingSnapshot.componentBooks.length} component books`
              : null,
          ].filter(Boolean).join(", ");
          const unchangedSummary = [
            !preparedImport.includesTools ? "Tools were unchanged" : null,
            !preparedImport.includesAdapters ? "Adapters were unchanged" : null,
            !preparedImport.includesComponentBooks ? "Component books were unchanged" : null,
          ].filter(Boolean).join(" ");
          alert(
            `Import completed successfully. Replaced ${replacedSummary}.` +
            (unchangedSummary ? ` ${unchangedSummary} because the import file did not include them.` : "")
          );
        } else {
          const addedSummary = [
            `${preparedImport.cases.length} cases`,
            `${preparedImport.components.length} components`,
            preparedImport.includesTools ? `${preparedImport.tools.length} tools` : null,
            preparedImport.includesAdapters ? `${preparedImport.adapters.length} adapters` : null,
            preparedImport.includesComponentBooks
              ? `${preparedImport.componentBooks.length} component books`
              : null,
          ].filter(Boolean).join(", ");
          alert(
            `Import completed successfully. Added ${addedSummary}.`
          );
        }
      } catch (error) {
        await invalidateCatalogQueries();
        alert(error instanceof Error ? error.message : 'Import failed. No existing data was changed.');
      }
    };
    input.click();
  };

  const getStockStatus = (quantity: number, minQuantity: number = 5) => {
    if (quantity === 0) return "empty";
    if (quantity <= minQuantity / 2) return "critical";
    if (quantity <= minQuantity) return "low";
    return "good";
  };

  const getStockColor = (status: string) => {
    switch (status) {
      case "good": return "bg-green-50 border-green-300";
      case "low": return "bg-yellow-50 border-yellow-300";
      case "critical": return "bg-red-50 border-red-300";
      default: return "bg-gray-50 border-dashed border-gray-300";
    }
  };

  const calculateStats = () => {
    if (!selectedCase || !selectedCase.compartments) return { totalComponents: 0, totalQuantity: 0, lowStock: 0, emptySlots: 0 };

    const components = selectedCase.compartments
      .map(c => c.component)
      .filter(Boolean) as Component[];

    return {
      totalComponents: components.length,
      totalQuantity: components.reduce((sum, c) => sum + c.quantity, 0),
      lowStock: components.filter(c => c.quantity <= (c.minQuantity || 5)).length,
      emptySlots: selectedCase.compartments.filter(c => !c.component).length,
    };
  };

  const stats = calculateStats();
  const selectedCaseIsUnorganized = selectedCase?.model === UNORGANIZED_CASE_MODEL;

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        cases={orderedCases}
        selectedCaseId={selectedCaseId}
        isLibraryActive={selectedCaseId === null && !isToolsView && !isAdaptersView && !isBooksView}
        isToolsActive={isToolsView}
        isAdaptersActive={isAdaptersView}
        isBooksActive={isBooksView}
        onShowLibrary={handleShowLibrary}
        onShowTools={handleShowTools}
        onShowAdapters={handleShowAdapters}
        onShowBooks={handleShowBooks}
        onCaseSelect={handleCaseSelect}
        onCaseReorder={handleCaseReorder}
        onCaseDelete={(case_) => deleteCaseMutation.mutate(case_)}
        onAddCase={() => setShowAddCase(true)}
        onOpenKicadSettings={() => setShowKicadSettings(true)}
        isCaseReordering={reorderCasesMutation.isPending}
        deletingCaseId={deleteCaseMutation.isPending ? deleteCaseMutation.variables?.id : null}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
      />

      <div className={`app-main ${selectedCase ? "case-detail-main" : "case-library-main"}`}>
        {/* Top Bar */}
        <header className="app-header">
          <div className="header-topline">
            <div className="header-title-group">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mobile-menu-button"
                onClick={() => setIsSidebarOpen(true)}
                aria-label="Open navigation"
              >
                <Menu className="h-5 w-5" />
              </Button>
              <div className="flex min-w-0 items-center gap-2">
                <div className="mobile-brand-mark"><Cpu className="h-4 w-4" /></div>
                <h2 className="truncate text-2xl font-semibold text-gray-900">
                  {selectedCase?.name || (isToolsView ? "Tools" : isAdaptersView ? "Adapters" : isBooksView ? "Component Books" : "Case Library")}
                </h2>
                {selectedCase && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={openRenameCase}
                      title="Edit case name"
                      aria-label="Edit case name"
                      className="h-8 w-8 shrink-0 p-0"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setImageCase(selectedCase)}
                      title="Manage case media"
                      aria-label={`Manage media for ${selectedCase.name}`}
                      className="h-8 w-8 shrink-0 p-0"
                    >
                      <Camera className="h-4 w-4" />
                    </Button>
                    {selectedCase.model.startsWith("CUSTOM-") && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setLayoutCase(selectedCase)}
                        title="Edit custom compartment layout"
                        aria-label={`Edit compartment layout for ${selectedCase.name}`}
                        className="h-8 w-8 shrink-0 p-0"
                      >
                        <Ruler className="h-4 w-4" />
                      </Button>
                    )}
                  </>
                )}
              </div>
              {selectedCase && (
                <>
                  <span className="case-model-badge">
                    {selectedCase.model.replace("LAYOUT-", "").replace("-BOTH", "")}
                  </span>
                  <span className="case-full-badge">
                    <span className="status-dot"></span>
                    {selectedCase.compartments ? Math.round(((selectedCase.compartments.length - stats.emptySlots) / selectedCase.compartments.length) * 100) : 0}% Full
                  </span>
                </>
              )}
            </div>

            <div className="header-actions">
              {selectedCase ? (
                <>
              <div className="view-toggle segmented-control">
                <Button
                  type="button"
                  size="sm"
                  variant={interactionMode === "view" ? "default" : "ghost"}
                  onClick={() => handleInteractionModeChange("view")}
                  aria-pressed={interactionMode === "view"}
                  className="h-8"
                >
                  <Eye className="h-4 w-4" />
                  View
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={interactionMode === "edit" ? "default" : "ghost"}
                  onClick={() => handleInteractionModeChange("edit")}
                  aria-pressed={interactionMode === "edit"}
                  className="h-8"
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </Button>
              </div>
              <div className="view-toggle segmented-control">
                <Button
                  type="button"
                  size="sm"
                  variant={displayMode === "grid" ? "default" : "ghost"}
                  onClick={() => handleDisplayModeChange("grid")}
                  aria-pressed={displayMode === "grid"}
                  className="h-8"
                >
                  <LayoutGrid className="h-4 w-4" />
                  Grid
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={displayMode === "list" ? "default" : "ghost"}
                  onClick={() => handleDisplayModeChange("list")}
                  aria-pressed={displayMode === "list"}
                  className="h-8"
                >
                  <List className="h-4 w-4" />
                  List
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={displayMode === "image" ? "default" : "ghost"}
                  onClick={() => handleDisplayModeChange("image")}
                  aria-pressed={displayMode === "image"}
                  className="h-8"
                >
                  <Image className="h-4 w-4" />
                  Image
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={displayMode === "case3d" ? "default" : "ghost"}
                  onClick={() => handleDisplayModeChange("case3d")}
                  aria-pressed={displayMode === "case3d"}
                  className="h-8"
                >
                  <Box className="h-4 w-4" />
                  3D Case
                </Button>
              </div>
              {copiedComponent && (
                <span
                  className="inline-flex max-w-44 items-center gap-1 truncate rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-800"
                  title={`Copied: ${copiedComponent.name}`}
                >
                  <Clipboard className="h-3 w-3 shrink-0" />
                  <span className="truncate">Copied: {copiedComponent.name}</span>
                </span>
              )}
              <div className="search-field">
                <Input
                  type="text"
                  placeholder="Search components..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter' && searchQuery.trim()) {
                      setLocation(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
                    }
                  }}
                  className="w-full pl-10"
                />
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
              </div>
              <FilterDropdown
                selectedCategories={selectedCategories}
                onCategoriesChange={setSelectedCategories}
              />
                </>
              ) : isToolsView ? (
                <Button type="button" onClick={handleAddTool} className="library-add-case-button">
                  <Plus className="h-4 w-4" />
                  Add tool
                </Button>
              ) : isAdaptersView ? (
                <Button type="button" onClick={handleAddAdapter} className="library-add-case-button">
                  <Plus className="h-4 w-4" />
                  Add adapter
                </Button>
              ) : isBooksView ? null : (
                <Button type="button" onClick={() => setShowAddCase(true)} className="library-add-case-button">
                  <Plus className="h-4 w-4" />
                  Add case
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={importData} title="Import Data" className="toolbar-icon-button">
                <Plus className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setLocation("/quantities")} title="Edit Quantities" className="toolbar-icon-button">
                <ClipboardList className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocation(selectedCaseId ? `/labels?caseId=${selectedCaseId}` : "/labels")}
                title="Print Labels"
                className="toolbar-icon-button"
              >
                <Tags className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowBomLocator(true)} title="BOM Locator" className="toolbar-icon-button">
                <FileSpreadsheet className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowImportGuide(true)} title="Import Guide" className="toolbar-icon-button">
                <HelpCircle className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={exportData} title="Export Data" className="toolbar-icon-button">
                <Download className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="app-content">
          {selectedCase && selectedCase.compartments ? (
            <>
              <div className="content-intro">
                <div>
                  <p className="eyebrow">Inventory overview</p>
                  <p className="content-helper">Tap a compartment to view details or update stock.</p>
                </div>
                <div className="content-shortcut"><span>⌘</span> K <span className="shortcut-label">to search</span></div>
              </div>
              {displayMode === "grid" && (
                selectedCaseIsUnorganized ? (
                  <CaseUnorganizedListView
                    case_={selectedCase}
                    onCompartmentClick={handleCompartmentClick}
                    searchQuery={searchQuery}
                    interactionMode={interactionMode}
                    hasCopiedComponent={!!copiedComponent}
                    copiedComponentId={copiedComponent?.id}
                    onCopyCompartment={handleCopyCompartment}
                    onPasteCompartment={handlePasteCompartment}
                  />
                ) : (
                  <CaseGrid
                    case_={selectedCase}
                    onCompartmentClick={handleCompartmentClick}
                    searchQuery={searchQuery}
                    interactionMode={interactionMode}
                    hasCopiedComponent={!!copiedComponent}
                    copiedComponentId={copiedComponent?.id}
                    onCopyCompartment={handleCopyCompartment}
                    onPasteCompartment={handlePasteCompartment}
                  />
                )
              )}

              {displayMode === "list" && (
                selectedCaseIsUnorganized ? (
                  <CaseUnorganizedListView
                    case_={selectedCase}
                    onCompartmentClick={handleCompartmentClick}
                    searchQuery={searchQuery}
                    interactionMode={interactionMode}
                    hasCopiedComponent={!!copiedComponent}
                    copiedComponentId={copiedComponent?.id}
                    onCopyCompartment={handleCopyCompartment}
                    onPasteCompartment={handlePasteCompartment}
                  />
                ) : (
                  <CaseListView
                    case_={selectedCase}
                    onCompartmentClick={handleCompartmentClick}
                    searchQuery={searchQuery}
                    interactionMode={interactionMode}
                    hasCopiedComponent={!!copiedComponent}
                    copiedComponentId={copiedComponent?.id}
                    onCopyCompartment={handleCopyCompartment}
                    onPasteCompartment={handlePasteCompartment}
                  />
                )
              )}

              {displayMode === "image" && (
                <CaseImageView
                  case_={selectedCase}
                  onCompartmentClick={handleCompartmentClick}
                  searchQuery={searchQuery}
                  interactionMode={interactionMode}
                  hasCopiedComponent={!!copiedComponent}
                  copiedComponentId={copiedComponent?.id}
                  onCopyCompartment={handleCopyCompartment}
                  onPasteCompartment={handlePasteCompartment}
                />
              )}

              {displayMode === "case3d" && (
                <Suspense
                  fallback={(
                    <div
                      className="flex min-h-[420px] items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-sm text-slate-300"
                      role="status"
                    >
                      Loading 3D case view…
                    </div>
                  )}
                >
                  <Case3dView
                    case_={selectedCase}
                    layer={requestedLayer}
                    selectedComponentId={requestedComponentId}
                    searchQuery={searchQuery}
                    matchingComponentIds={searchResultIds}
                    onManageMedia={() => setImageCase(selectedCase)}
                    onLayerChange={handle3dLayerChange}
                    onSelectCompartment={handle3dSelectCompartment}
                    onOpenComponent={handle3dOpenComponent}
                    onFailure={handle3dFailure}
                  />
                </Suspense>
              )}

              {/* Quick Stats */}
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="stat-label">Total components</p>
                      <p className="stat-value">{stats.totalComponents}</p>
                    </div>
                    <div className="stat-icon stat-icon-blue">
                      <Cpu className="h-4 w-4" />
                    </div>
                  </div>
                </div>

                <div className="stat-card">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="stat-label">Total quantity</p>
                      <p className="stat-value">{stats.totalQuantity}</p>
                    </div>
                    <div className="stat-icon stat-icon-green">
                      <Package className="h-4 w-4" />
                    </div>
                  </div>
                </div>

                <div className="stat-card">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="stat-label">Low stock</p>
                      <p className="stat-value stat-value-orange">{stats.lowStock}</p>
                    </div>
                    <div className="stat-icon stat-icon-orange">
                      <AlertTriangle className="h-4 w-4" />
                    </div>
                  </div>
                </div>

                <div className="stat-card">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="stat-label">Empty slots</p>
                      <p className="stat-value stat-value-muted">{stats.emptySlots}</p>
                    </div>
                    <div className="stat-icon stat-icon-muted">
                      <Grid2X2 className="h-4 w-4" />
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : isToolsView ? (
            <ToolsView onAddTool={handleAddTool} onEditTool={handleEditTool} />
          ) : isAdaptersView ? (
            <AdaptersView onAddAdapter={handleAddAdapter} onEditAdapter={handleEditAdapter} />
          ) : isBooksView ? (
            <ComponentBooksView />
          ) : (
            <CaseLibraryView
              cases={libraryCases}
              onCaseOpen={handleCaseSelect}
              onManageImages={setImageCase}
              onAddCase={() => setShowAddCase(true)}
            />
          )}
        </main>
      </div>



      {/* Dialogs */}
      <EditComponentDialog
        isOpen={!!editingComponent}
        onClose={() => setEditingComponent(null)}
        compartment={editingComponent?.compartment}
        component={editingComponent?.component}
        onSuccess={() => setEditingComponent(null)}
      />

      <ComponentInfoDialog
        isOpen={!!viewingComponent}
        onClose={() => setViewingComponent(null)}
        compartment={viewingComponent?.compartment}
        component={viewingComponent?.component}
      />

      <ToolEditorDialog
        open={showToolEditor}
        tool={editingTool}
        onClose={closeToolEditor}
      />

      <AdapterEditorDialog
        open={showAdapterEditor}
        adapter={editingAdapter}
        onClose={closeAdapterEditor}
      />

      <KicadSettingsDialog
        open={showKicadSettings}
        onOpenChange={setShowKicadSettings}
      />

      <AddCaseDialog
        isOpen={showAddCase}
        onClose={() => setShowAddCase(false)}
        onSuccess={(createdCase) => {
          setShowAddCase(false);
          setImageCase(createdCase);
        }}
      />

      <CaseImageManagerDialog
        case_={imageCase}
        isOpen={!!imageCase}
        onClose={() => setImageCase(null)}
      />

      <EditCaseLayoutDialog
        case_={layoutCase}
        isOpen={!!layoutCase}
        onClose={() => setLayoutCase(null)}
      />

      <ImportGuideDialog
        isOpen={showImportGuide}
        onClose={() => setShowImportGuide(false)}
      />

      <BomLocatorDialog
        isOpen={showBomLocator}
        onClose={() => setShowBomLocator(false)}
      />

      <Dialog open={showRenameCase} onOpenChange={setShowRenameCase}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Case Name</DialogTitle>
          </DialogHeader>

          <form onSubmit={submitRenameCase} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="case-name" className="text-sm font-medium text-gray-700">
                Case Name
              </label>
              <Input
                id="case-name"
                value={renameCaseName}
                onChange={(event) => setRenameCaseName(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </div>

            <div className="flex space-x-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowRenameCase(false)}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={renameCaseMutation.isPending}
              >
                {renameCaseMutation.isPending ? "Saving..." : "Save Name"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
