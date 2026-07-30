import type { Tool as CatalogTool } from "@shared/schema";

export type Tool = CatalogTool;

export type ToolInput = Omit<Tool, "id">;

export const TOOL_CATEGORY_SUGGESTIONS = [
  "Oscilloscope",
  "Probe",
  "Multimeter",
  "Logic Analyzer",
  "Logic Probe",
  "Thermal Camera",
  "Microscope",
  "Component Tester",
  "Power Supply",
  "Signal Generator",
  "Programmer/Debugger",
  "Soldering/Rework",
  "Measurement Accessory",
  "Other",
] as const;
