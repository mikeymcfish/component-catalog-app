import type { CaseModelCalibration } from "@shared/model-calibration";
import type { CaseWithCompartments } from "@shared/schema";

export type CaseSceneLayer = "top" | "bottom";
export type ComponentScaleMode = "display" | "actual";

export type CaseSceneMappingSource =
  | "named-anchors"
  | "calibration"
  | "instance-grid"
  | "unavailable";

export interface CaseSceneMappingStatus {
  source: CaseSceneMappingSource;
  mappedCount: number;
  expectedCount: number;
  missingPositions: string[];
  message?: string;
}

export type CaseSceneCalibrationPickMode = "origin" | "columnEnd" | "rowEnd";

export interface CaseSceneCalibrationPick {
  mode: CaseSceneCalibrationPickMode;
  /** Case-model-local coordinates, before metersPerModelUnit is applied. */
  point: [number, number, number];
}

export interface CaseInventorySceneHandle {
  resetCamera(): void;
  focusCompartment(compartmentId: number): boolean;
  enterFullscreen(): Promise<void>;
}

export interface CaseInventorySceneModel {
  layer: CaseSceneLayer;
  url: string;
  calibration?: CaseModelCalibration | null;
}

export interface CaseInventorySceneProps {
  case_: CaseWithCompartments;
  /** One or both independently calibrated halves rendered as one open case. */
  caseModels: readonly CaseInventorySceneModel[];
  /** Half targeted by the optional calibration controls. */
  calibrationLayer: CaseSceneLayer;
  visibleCompartmentIds?: readonly number[] | ReadonlySet<number>;
  /** Compartments whose assets should load immediately after the selection. */
  priorityCompartmentIds?: readonly number[] | ReadonlySet<number>;
  selectedCompartmentId?: number | null;
  /** Display mode normalizes each component's longest world-space AABB edge. */
  componentScaleMode?: ComponentScaleMode;
  /** Target longest edge used by display mode, in meters. */
  componentDisplaySizeMeters?: number;
  /** Keeps the loaded case in the scene while allowing it to be visually hidden. */
  showCaseModel?: boolean;
  /** Renders geometry-based compartment labels on the case rim plane. */
  showCompartmentNumbers?: boolean;
  calibrationActive?: boolean;
  calibrationPickMode?: CaseSceneCalibrationPickMode | null;
  onCalibrationPick?: (pick: CaseSceneCalibrationPick) => void;
  onSelectCompartment?: (compartmentId: number | null) => void;
  /** Receives a component ID (not a compartment ID). */
  onOpenComponent?: (componentId: number) => void;
  onMappingStatus?: (layer: CaseSceneLayer, status: CaseSceneMappingStatus) => void;
  onFailure?: (error: Error) => void;
  className?: string;
}
