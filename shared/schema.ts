import { pgTable, text, serial, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { customCaseLayoutGeometrySchema, type CustomCaseGeometry } from "./custom-case-layout";
import { caseModelCalibrationSchema, type CaseModelCalibration } from "./model-calibration";
import {
  componentModelRotationSchema,
  type ComponentModelRotation,
} from "./component-model-rotation";

export const ADAPTER_ENDPOINT_TYPE_VALUES = [
  "qfp",
  "qfn",
  "soic",
  "dip",
  "d-sub",
  "terminal-block",
  "usb",
  "pin-header",
  "debug-header",
  "power",
  "cable",
  "other",
] as const;

export const adapterEndpointTypeSchema = z.enum(ADAPTER_ENDPOINT_TYPE_VALUES);
export type AdapterEndpointType = z.infer<typeof adapterEndpointTypeSchema>;

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").default("#6366f1"), // Hex color for UI
  iconName: text("icon_name").default("other"), // Icon identifier
});

export const cases = pgTable("cases", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  model: text("model").notNull(),
  rows: integer("rows").notNull(),
  cols: integer("cols").notNull(),
  hasBottom: boolean("has_bottom").default(false),
  description: text("description"),
  closedImageUrl: text("closed_image_url"),
  openImageUrl: text("open_image_url"),
  topModel3dUrl: text("top_model_3d_url"),
  topModel3dName: text("top_model_3d_name"),
  topModel3dSource: text("top_model_3d_source"),
  topModel3dCalibration: jsonb("top_model_3d_calibration").$type<CaseModelCalibration>(),
  bottomModel3dUrl: text("bottom_model_3d_url"),
  bottomModel3dName: text("bottom_model_3d_name"),
  bottomModel3dSource: text("bottom_model_3d_source"),
  bottomModel3dCalibration: jsonb("bottom_model_3d_calibration").$type<CaseModelCalibration>(),
  layoutGeometry: jsonb("layout_geometry").$type<CustomCaseGeometry>(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").default(true),
});

export const compartments = pgTable("compartments", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull().references(() => cases.id),
  position: text("position").notNull(), // A1, A2, B1, etc.
  row: integer("row").notNull(),
  col: integer("col").notNull(),
  layer: text("layer").notNull().default("top"), // top or bottom
});

export const components = pgTable("components", {
  id: serial("id").primaryKey(),
  compartmentId: integer("compartment_id").notNull().references(() => compartments.id),
  name: text("name").notNull(),
  categoryId: integer("category_id").notNull().references(() => categories.id),
  packageSize: text("package_size"),
  quantity: integer("quantity").notNull().default(0),
  minQuantity: integer("min_quantity").default(5),
  datasheetUrl: text("datasheet_url"),
  photoUrl: text("photo_url"),
  model3dUrl: text("model_3d_url"),
  model3dName: text("model_3d_name"),
  model3dSource: text("model_3d_source"),
  model3dRotation: jsonb("model_3d_rotation").$type<ComponentModelRotation>(),
  notes: text("notes"),
  checkedOut: boolean("checked_out").default(false),
  checkedOutBy: text("checked_out_by"),
  checkedOutDate: timestamp("checked_out_date"),
});

export const tools = pgTable("tools", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  manufacturer: text("manufacturer"),
  modelNumber: text("model_number"),
  productUrl: text("product_url"),
  imageUrl: text("image_url"),
  quantity: integer("quantity").notNull().default(1),
  location: text("location"),
  capabilities: text("capabilities"),
  notes: text("notes"),
});

export const adapters = pgTable("adapters", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  manufacturer: text("manufacturer"),
  modelNumber: text("model_number"),
  productUrl: text("product_url"),
  imageUrl: text("image_url"),
  endpointA: text("endpoint_a"),
  endpointAType: text("endpoint_a_type"),
  endpointB: text("endpoint_b"),
  endpointBType: text("endpoint_b_type"),
  quantity: integer("quantity").notNull().default(1),
  location: text("location"),
  compatibility: text("compatibility"),
  notes: text("notes"),
});

export const componentBooks = pgTable("component_books", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  manufacturer: text("manufacturer"),
  packageSize: text("package_size"),
  productUrl: text("product_url"),
  imageUrl: text("image_url"),
  description: text("description"),
  notes: text("notes"),
});

export const componentBookItems = pgTable("component_book_items", {
  id: serial("id").primaryKey(),
  bookId: integer("book_id").notNull().references(() => componentBooks.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  partNumber: text("part_number"),
  value: text("value"),
  packageSize: text("package_size"),
  quantity: integer("quantity"),
  notes: text("notes"),
});

export const insertCategorySchema = createInsertSchema(categories).omit({
  id: true,
});

export const insertCaseSchema = createInsertSchema(cases).omit({
  id: true,
  sortOrder: true,
  isActive: true,
}).extend({
  layoutGeometry: customCaseLayoutGeometrySchema.optional().nullable(),
  topModel3dCalibration: caseModelCalibrationSchema.optional().nullable(),
  bottomModel3dCalibration: caseModelCalibrationSchema.optional().nullable(),
});

export const insertCompartmentSchema = createInsertSchema(compartments).omit({
  id: true,
});

export const insertComponentSchema = createInsertSchema(components).omit({
  id: true,
}).extend({
  model3dRotation: componentModelRotationSchema.optional().nullable(),
});

export const insertToolSchema = createInsertSchema(tools).omit({
  id: true,
}).extend({
  quantity: z.number().int().min(1).optional(),
});

export const insertAdapterSchema = createInsertSchema(adapters).omit({
  id: true,
}).extend({
  quantity: z.number().int().min(1).optional(),
});

export const insertComponentBookSchema = createInsertSchema(componentBooks).omit({
  id: true,
});

export const insertComponentBookItemSchema = createInsertSchema(componentBookItems).omit({
  id: true,
}).extend({
  quantity: z.number().int().min(0).optional().nullable(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type InsertCase = z.infer<typeof insertCaseSchema>;
export type InsertCompartment = z.infer<typeof insertCompartmentSchema>;
export type InsertComponent = z.infer<typeof insertComponentSchema>;
export type InsertTool = z.infer<typeof insertToolSchema>;
export type InsertAdapter = z.infer<typeof insertAdapterSchema>;
export type InsertComponentBook = z.infer<typeof insertComponentBookSchema>;
export type InsertComponentBookItem = z.infer<typeof insertComponentBookItemSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Category = typeof categories.$inferSelect;
export type Case = typeof cases.$inferSelect;
export type Compartment = typeof compartments.$inferSelect;
export type Component = typeof components.$inferSelect;
export type Tool = typeof tools.$inferSelect;
export type Adapter = typeof adapters.$inferSelect;
export type ComponentBook = typeof componentBooks.$inferSelect;
export type ComponentBookItem = typeof componentBookItems.$inferSelect;
export type User = typeof users.$inferSelect;

export type ComponentBookWithItems = ComponentBook & {
  items: ComponentBookItem[];
};

export type ComponentBookSearchResult = ComponentBookItem & {
  book: ComponentBook;
};

export type CaseWithCompartments = Case & {
  compartments: (Compartment & { component?: Component })[];
};
