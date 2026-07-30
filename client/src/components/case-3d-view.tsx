import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Box,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eye,
  Hash,
  Layers,
  Loader2,
  MapPin,
  Ruler,
  Save,
  Settings2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type {
  CaseInventorySceneHandle,
  CaseSceneCalibrationPickMode,
  CaseSceneMappingStatus,
  ComponentScaleMode,
} from "@/lib/case-3d-scene/types";
import { resolveAvailableCaseLayer } from "@/lib/case-3d-scene/model-set";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  getManagedModelAssetId,
  parseCalibrationForModel,
  type CaseModelCalibration,
  type ModelVector3,
} from "@shared/model-calibration";
import type { Case, CaseWithCompartments, Compartment, Component } from "@shared/schema";

type CaseModelLayer = "top" | "bottom";
type InventoryEntry = Compartment & { component: Component };
type PickPoint = [number, number, number];

const CaseInventoryScene = lazy(() => import("@/components/case-inventory-scene"));

const DEFAULT_COMPONENT_DISPLAY_SIZE_MM = 10;
const COMPONENT_SCALE_MODES: Array<{ mode: ComponentScaleMode; label: string }> = [
  { mode: "display", label: "Display size" },
  { mode: "actual", label: "Actual size (1:1)" },
];

interface Case3dViewProps {
  case_: CaseWithCompartments;
  layer: CaseModelLayer;
  selectedComponentId: number | null;
  searchQuery: string;
  matchingComponentIds?: readonly number[];
  onManageMedia: () => void;
  onLayerChange: (layer: CaseModelLayer) => void;
  onSelectCompartment: (compartmentId: number | null) => void;
  onOpenComponent: (componentId: number) => void;
  onFailure: (error: Error) => void;
}

interface CaseHalfModel {
  layer: CaseModelLayer;
  label: string;
  url: string;
  name: string;
}

interface CalibrationPoints {
  origin: PickPoint | null;
  columnEnd: PickPoint | null;
  rowEnd: PickPoint | null;
}

const EMPTY_CALIBRATION_POINTS: CalibrationPoints = {
  origin: null,
  columnEnd: null,
  rowEnd: null,
};

function toVector(point: PickPoint): ModelVector3 {
  return { x: point[0], y: point[1], z: point[2] };
}

function axisVector(from: PickPoint, to: PickPoint): ModelVector3 | null {
  const x = to[0] - from[0];
  const y = to[1] - from[1];
  const z = to[2] - from[2];
  const length = Math.hypot(x, y, z);
  if (length < 1e-8) return null;
  return { x, y, z };
}

function normalizedCross(
  left: ModelVector3,
  right: ModelVector3,
  direction: 1 | -1,
): ModelVector3 | null {
  const x = (left.y * right.z - left.z * right.y) * direction;
  const y = (left.z * right.x - left.x * right.z) * direction;
  const z = (left.x * right.y - left.y * right.x) * direction;
  const length = Math.hypot(x, y, z);
  if (length < 1e-8) return null;
  return { x: x / length, y: y / length, z: z / length };
}

function componentMatches(component: Component, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;

  return [component.name, component.packageSize, component.notes, component.model3dName]
    .filter((value): value is string => Boolean(value))
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery));
}

function formatPoint(point: PickPoint | null) {
  if (!point) return "Not picked";
  return point.map(value => value.toFixed(3)).join(", ");
}

function mappingLabel(status: CaseSceneMappingStatus | null) {
  switch (status?.source) {
    case "named-anchors":
      return "Named anchors";
    case "calibration":
      return "Saved calibration";
    case "instance-grid":
      return "Detected grid";
    case "unavailable":
      return "Needs calibration";
    default:
      return "Mapping scene";
  }
}

function isUnavailableMapping(status: CaseSceneMappingStatus | null) {
  return status?.source === "unavailable";
}

export default function Case3dView({
  case_,
  layer,
  selectedComponentId,
  searchQuery,
  matchingComponentIds = [],
  onManageMedia,
  onLayerChange,
  onSelectCompartment,
  onOpenComponent,
  onFailure,
}: Case3dViewProps) {
  const sceneRef = useRef<CaseInventorySceneHandle>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [componentScaleMode, setComponentScaleMode] = useState<ComponentScaleMode>("display");
  const [componentDisplaySizeMm, setComponentDisplaySizeMm] = useState(
    DEFAULT_COMPONENT_DISPLAY_SIZE_MM,
  );
  const [componentDisplaySizeDraft, setComponentDisplaySizeDraft] = useState(
    String(DEFAULT_COMPONENT_DISPLAY_SIZE_MM),
  );
  const [showCaseModel, setShowCaseModel] = useState(true);
  const [showCompartmentNumbers, setShowCompartmentNumbers] = useState(false);
  const [mappingStatuses, setMappingStatuses] = useState<
    Partial<Record<CaseModelLayer, CaseSceneMappingStatus>>
  >({});
  const [showCalibration, setShowCalibration] = useState(false);
  const [calibrationPickMode, setCalibrationPickMode] = useState<CaseSceneCalibrationPickMode | null>(null);
  const [calibrationPoints, setCalibrationPoints] = useState<CalibrationPoints>(
    EMPTY_CALIBRATION_POINTS,
  );
  const [metersPerModelUnit, setMetersPerModelUnit] = useState("1");
  const [rimOffset, setRimOffset] = useState("");
  const [normalDirection, setNormalDirection] = useState<1 | -1>(1);

  const models = useMemo<CaseHalfModel[]>(() => {
    const availableModels: CaseHalfModel[] = [];

    if (case_.topModel3dUrl) {
      availableModels.push({
        layer: "top",
        label: "Top",
        url: case_.topModel3dUrl,
        name: case_.topModel3dName || `${case_.name} top half`,
      });
    }

    if (case_.bottomModel3dUrl) {
      availableModels.push({
        layer: "bottom",
        label: "Bottom",
        url: case_.bottomModel3dUrl,
        name: case_.bottomModel3dName || `${case_.name} bottom half`,
      });
    }

    return availableModels;
  }, [
    case_.bottomModel3dName,
    case_.bottomModel3dUrl,
    case_.name,
    case_.topModel3dName,
    case_.topModel3dUrl,
  ]);

  const activeLayer = resolveAvailableCaseLayer(models, layer);
  const activeModel = models.find(model => model.layer === activeLayer);
  const activeCalibration = useMemo(
    () => activeModel
      ? parseCalibrationForModel(
          activeLayer === "top"
            ? case_.topModel3dCalibration
            : case_.bottomModel3dCalibration,
          activeModel.url,
        )
      : null,
    [
      activeLayer,
      activeModel,
      case_.bottomModel3dCalibration,
      case_.topModel3dCalibration,
    ],
  );
  const activeAssetId = getManagedModelAssetId(activeModel?.url);

  useEffect(() => {
    setShowCalibration(false);
    setCalibrationPickMode(null);
    setCalibrationPoints(EMPTY_CALIBRATION_POINTS);
    setMetersPerModelUnit(String(activeCalibration?.metersPerModelUnit ?? 1));
    setRimOffset(
      activeCalibration?.rimOffset === undefined ? "" : String(activeCalibration.rimOffset),
    );
    setNormalDirection(1);
  }, [activeLayer, activeAssetId, case_.id]);

  useEffect(() => {
    setMappingStatuses({});
  }, [case_.id, case_.bottomModel3dUrl, case_.topModel3dUrl]);

  useEffect(() => {
    if (!activeModel || activeLayer === layer) return;
    onLayerChange(activeLayer);
  }, [activeLayer, activeModel, layer, onLayerChange]);

  useEffect(() => {
    setShowCaseModel(true);
    setShowCompartmentNumbers(false);
  }, [case_.id]);

  const serverMatchIds = useMemo(
    () => new Set(matchingComponentIds),
    [matchingComponentIds],
  );

  const allEntries = useMemo<InventoryEntry[]>(() => {
    return case_.compartments
      .filter(
        (compartment): compartment is InventoryEntry =>
          Boolean(compartment.component),
      )
      .sort((left, right) =>
        left.layer.localeCompare(right.layer) ||
        left.row - right.row ||
        left.col - right.col ||
        left.id - right.id
      );
  }, [case_.compartments]);

  const selectedEntry = useMemo(
    () => allEntries.find(entry => entry.component.id === selectedComponentId) || null,
    [allEntries, selectedComponentId],
  );

  const searchIsActive = Boolean(searchQuery.trim());
  const matchingEntries = useMemo(() => {
    if (!searchIsActive) return allEntries;
    return allEntries.filter(
      entry =>
        serverMatchIds.has(entry.component.id) || componentMatches(entry.component, searchQuery),
    );
  }, [allEntries, searchIsActive, searchQuery, serverMatchIds]);

  const requestedVisibleEntries = useMemo(() => {
    const matchingIds = new Set(matchingEntries.map(entry => entry.id));
    const requested = searchIsActive
      ? [
          ...matchingEntries,
          ...allEntries.filter(entry => !matchingIds.has(entry.id)),
        ]
      : allEntries;

    if (!selectedEntry || requested.some(entry => entry.id === selectedEntry.id)) {
      return selectedEntry
        ? [selectedEntry, ...requested.filter(entry => entry.id !== selectedEntry.id)]
        : requested;
    }
    return [selectedEntry, ...requested];
  }, [allEntries, matchingEntries, searchIsActive, selectedEntry]);

  const visibleCompartmentIds = useMemo(() => {
    return requestedVisibleEntries.map(entry => entry.id);
  }, [requestedVisibleEntries]);

  const priorityCompartmentIds = useMemo(
    () => searchIsActive ? matchingEntries.map(entry => entry.id) : [],
    [matchingEntries, searchIsActive],
  );

  const companionEntries = useMemo(() => {
    if (!searchIsActive) return allEntries;
    if (!selectedEntry || matchingEntries.some(entry => entry.id === selectedEntry.id)) {
      return matchingEntries;
    }
    return [selectedEntry, ...matchingEntries];
  }, [allEntries, matchingEntries, searchIsActive, selectedEntry]);
  const companionIncludesNonmatchingSelection = Boolean(
    searchIsActive &&
    selectedEntry &&
    !matchingEntries.some(entry => entry.id === selectedEntry.id),
  );
  const navigationEntries = companionEntries;
  const selectedIndex = navigationEntries.findIndex(
    entry => entry.component.id === selectedComponentId,
  );

  const selectEntry = (entry: InventoryEntry) => {
    onSelectCompartment(entry.id);
    requestAnimationFrame(() => sceneRef.current?.focusCompartment(entry.id));
  };

  const moveSelection = (direction: -1 | 1) => {
    if (navigationEntries.length === 0) return;
    const nextIndex = selectedIndex < 0
      ? direction === 1 ? 0 : navigationEntries.length - 1
      : (selectedIndex + direction + navigationEntries.length) % navigationEntries.length;
    selectEntry(navigationEntries[nextIndex]);
  };

  const calibrationCandidate = useMemo<CaseModelCalibration | null>(() => {
    if (!activeAssetId) return null;

    const parsedScale = Number(metersPerModelUnit);
    if (!Number.isFinite(parsedScale) || parsedScale <= 0) return null;

    const parsedRimOffset = rimOffset.trim() === "" ? undefined : Number(rimOffset);
    if (parsedRimOffset !== undefined && !Number.isFinite(parsedRimOffset)) return null;

    const origin = calibrationPoints.origin
      ? toVector(calibrationPoints.origin)
      : activeCalibration?.origin;
    const columnAxis = calibrationPoints.origin && calibrationPoints.columnEnd
      ? axisVector(calibrationPoints.origin, calibrationPoints.columnEnd)
      : activeCalibration?.columnAxis;
    const rowAxis = calibrationPoints.origin && calibrationPoints.rowEnd
      ? axisVector(calibrationPoints.origin, calibrationPoints.rowEnd)
      : activeCalibration?.rowAxis;

    if (!origin || !columnAxis || !rowAxis) return null;

    const pickedNormal = calibrationPoints.origin && calibrationPoints.columnEnd && calibrationPoints.rowEnd
      ? normalizedCross(columnAxis, rowAxis, normalDirection)
      : null;
    const savedNormal = activeCalibration?.outwardNormal;
    const outwardNormal = pickedNormal || (savedNormal
      ? normalDirection === -1
        ? { x: -savedNormal.x, y: -savedNormal.y, z: -savedNormal.z }
        : savedNormal
      : null);
    if (!outwardNormal) return null;

    return {
      version: 1,
      assetId: activeAssetId,
      metersPerModelUnit: parsedScale,
      origin,
      columnAxis,
      rowAxis,
      outwardNormal,
      ...(parsedRimOffset === undefined ? {} : { rimOffset: parsedRimOffset }),
      ...(activeCalibration?.anchorOverrides
        ? { anchorOverrides: activeCalibration.anchorOverrides }
        : {}),
    };
  }, [
    activeAssetId,
    activeCalibration,
    calibrationPoints,
    metersPerModelUnit,
    normalDirection,
    rimOffset,
  ]);

  const updateCachedCase = (updatedCase: Case) => {
    queryClient.setQueryData<CaseWithCompartments>(
      ["/api/cases", case_.id],
      current => current ? { ...current, ...updatedCase } : current,
    );
    queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
    queryClient.invalidateQueries({ queryKey: ["/api/cases", case_.id] });
  };

  const saveCalibrationMutation = useMutation({
    mutationFn: async (calibration: CaseModelCalibration) => {
      const response = await apiRequest(
        "PUT",
        `/api/cases/${case_.id}/models/${activeLayer}/calibration`,
        calibration,
      );
      return response.json() as Promise<Case>;
    },
    onSuccess: updatedCase => {
      updateCachedCase(updatedCase);
      setShowCalibration(false);
      setCalibrationPickMode(null);
      toast({
        title: `${activeLayer === "top" ? "Top" : "Bottom"} calibration saved`,
        description: "Component locations now use this model mapping.",
      });
    },
    onError: error => {
      toast({
        title: "Calibration could not be saved",
        description: error instanceof Error ? error.message : "Try the calibration again.",
        variant: "destructive",
      });
    },
  });

  const deleteCalibrationMutation = useMutation({
    mutationFn: async () => {
      if (!activeAssetId) throw new Error("The active model is not a managed GLB asset.");
      const response = await apiRequest(
        "DELETE",
        `/api/cases/${case_.id}/models/${activeLayer}/calibration`,
        { assetId: activeAssetId },
      );
      return response.json() as Promise<Case>;
    },
    onSuccess: updatedCase => {
      updateCachedCase(updatedCase);
      setShowCalibration(false);
      setCalibrationPickMode(null);
      toast({ title: "Calibration removed" });
    },
    onError: error => {
      toast({
        title: "Calibration could not be removed",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
    },
  });

  const beginCalibration = () => {
    setShowCaseModel(true);
    setShowCompartmentNumbers(false);
    setCalibrationPoints(EMPTY_CALIBRATION_POINTS);
    setMetersPerModelUnit(String(activeCalibration?.metersPerModelUnit ?? 1));
    setRimOffset(
      activeCalibration?.rimOffset === undefined ? "" : String(activeCalibration.rimOffset),
    );
    setNormalDirection(1);
    setCalibrationPickMode("origin");
    setShowCalibration(true);
  };

  const handleShowCaseModelChange = (checked: boolean) => {
    setShowCaseModel(checked);
    if (checked) setShowCompartmentNumbers(false);
  };

  const handleShowCompartmentNumbersChange = (checked: boolean) => {
    setShowCompartmentNumbers(checked);
    if (checked) setShowCaseModel(false);
  };

  const commitComponentDisplaySize = () => {
    const parsed = Number(componentDisplaySizeDraft);
    if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 1000) {
      setComponentDisplaySizeDraft(String(componentDisplaySizeMm));
      return;
    }
    const rounded = Math.round(parsed * 1000) / 1000;
    setComponentDisplaySizeMm(rounded);
    setComponentDisplaySizeDraft(String(rounded));
  };

  const handleCalibrationPick = ({
    mode,
    point,
  }: {
    mode: CaseSceneCalibrationPickMode;
    point: PickPoint;
  }) => {
    setCalibrationPoints(current => ({ ...current, [mode]: point }));
    setCalibrationPickMode(
      mode === "origin" ? "columnEnd" : mode === "columnEnd" ? "rowEnd" : null,
    );
  };

  const calibrationPreviewLayer = showCalibration ? activeLayer : null;
  const calibrationPreview = showCalibration
    ? calibrationCandidate || activeCalibration
    : null;
  const sceneModels = useMemo(
    () => models.map(model => {
      const savedCalibration = parseCalibrationForModel(
        model.layer === "top"
          ? case_.topModel3dCalibration
          : case_.bottomModel3dCalibration,
        model.url,
      );
      return {
        layer: model.layer,
        url: model.url,
        calibration: calibrationPreviewLayer === model.layer
          ? calibrationPreview
          : savedCalibration,
      };
    }),
    [
      calibrationPreview,
      calibrationPreviewLayer,
      case_.bottomModel3dCalibration,
      case_.topModel3dCalibration,
      models,
    ],
  );

  const handleMappingStatus = (
    mappedLayer: CaseModelLayer,
    status: CaseSceneMappingStatus,
  ) => {
    setMappingStatuses(current => current[mappedLayer] === status
      ? current
      : { ...current, [mappedLayer]: status });
  };

  const mappingStatus = mappingStatuses[activeLayer] ?? null;
  const mappingIsUnavailable = isUnavailableMapping(mappingStatus);
  useEffect(() => {
    if (!mappingIsUnavailable || !showCompartmentNumbers) return;
    setShowCompartmentNumbers(false);
    setShowCaseModel(true);
  }, [mappingIsUnavailable, showCompartmentNumbers]);

  if (!activeModel) {
    return (
      <section
        className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-600 bg-slate-900/70 px-6 py-14 text-center shadow-sm"
        aria-labelledby="case-3d-empty-title"
      >
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-600 bg-slate-800 text-indigo-300 shadow-inner">
          <Box className="h-8 w-8" aria-hidden="true" />
        </div>
        <h3 id="case-3d-empty-title" className="text-lg font-semibold text-slate-100">
          Add a 3D model of this case
        </h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">
          Upload the top half, bottom half, or both. A single model works on its own;
          two models are arranged automatically as one open case with a centered hinge.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={onManageMedia} className="gap-2">
            <Upload className="h-4 w-4" aria-hidden="true" />
            Manage case media
          </Button>
        </div>
        {searchIsActive && navigationEntries.length > 0 && (
          <div className="mt-5 flex items-center gap-2" aria-label="Search result navigation">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => moveSelection(-1)}
              className="border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700 hover:text-white"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              Previous
            </Button>
            <span className="text-xs text-slate-400">
              {selectedIndex >= 0 ? selectedIndex + 1 : 0} of {navigationEntries.length}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => moveSelection(1)}
              className="border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700 hover:text-white"
            >
              Next
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        )}
      </section>
    );
  }

  const hasBothModels = models.length === 2;
  const compartmentNumbersAreReady = models.every(
    model => Boolean(mappingStatuses[model.layer] && !isUnavailableMapping(mappingStatuses[model.layer] ?? null)),
  );
  const isSavingCalibration =
    saveCalibrationMutation.isPending || deleteCalibrationMutation.isPending;

  return (
    <section
      className="space-y-4 rounded-xl border border-slate-700 bg-slate-900/80 p-4 shadow-sm sm:p-6"
      aria-labelledby="case-3d-title"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Layers className="h-4 w-4 text-indigo-300" aria-hidden="true" />
            <h3 id="case-3d-title" className="text-base font-semibold text-slate-100">
              3D case view
            </h3>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                mappingIsUnavailable
                  ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
                  : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
              }`}
            >
              {showCalibration && calibrationCandidate
                ? "Calibration preview"
                : `${activeModel.label}: ${mappingLabel(mappingStatus)}`}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Both halves and all populated locations share one open-case scene. Select any
            compartment to focus it, or click a floating component to open its details.
          </p>
          {mappingStatus?.message && (
            <p className="mt-1 text-xs text-slate-500" aria-live="polite">
              {mappingStatus.message}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {hasBothModels && (
            <label className="flex items-center gap-2 rounded-md border border-slate-600 bg-slate-800 px-2 text-xs font-medium text-slate-300">
              Calibration half
              <select
                value={activeLayer}
                onChange={event => onLayerChange(event.target.value as CaseModelLayer)}
                disabled={showCalibration}
                aria-label="Half to calibrate"
                className="h-8 rounded border border-slate-600 bg-slate-950 px-2 text-sm text-slate-100 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30"
              >
                {models.map(model => (
                  <option key={model.layer} value={model.layer}>{model.label}</option>
                ))}
              </select>
            </label>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={beginCalibration}
            className={`gap-2 border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700 hover:text-white ${
              mappingIsUnavailable ? "border-amber-400/50 text-amber-100" : ""
            }`}
          >
            <Ruler className="h-4 w-4" aria-hidden="true" />
            {activeCalibration ? `Edit ${activeModel.label.toLowerCase()} calibration` : `Calibrate ${activeModel.label.toLowerCase()}`}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onManageMedia}
            className="border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700 hover:text-white"
          >
            Manage media
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-full border border-indigo-400/30 bg-indigo-400/10 px-3 py-1 font-medium text-indigo-200">
            {hasBothModels ? "Open assembly" : `${activeModel.label} half`}
          </span>
          {models.map(model => {
            const status = mappingStatuses[model.layer];
            const unavailable = isUnavailableMapping(status ?? null);
            return (
              <span
                key={model.layer}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  unavailable
                    ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                    : "border-slate-600 bg-slate-950/70 text-slate-300"
                }`}
              >
                {model.label}: {mappingLabel(status ?? null)}
              </span>
            );
          })}
          {!hasBothModels && (
            <span className="text-slate-500">
              Add the {activeModel.layer === "top" ? "bottom" : "top"} half from Manage media for a hinged assembly.
            </span>
          )}
        </div>

        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
          <fieldset className="flex h-14 items-center gap-4 rounded-lg border border-slate-700 bg-slate-950/70 px-3">
            <legend className="sr-only">3D scene visibility</legend>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-200">
              <Eye className="h-4 w-4 text-indigo-300" aria-hidden="true" />
              <span>Case</span>
              <Switch
                checked={showCaseModel}
                onCheckedChange={handleShowCaseModelChange}
                disabled={showCalibration}
                aria-label="Show case model"
                className="data-[state=checked]:bg-indigo-500 data-[state=unchecked]:bg-slate-700"
              />
            </label>
            <span className="h-6 w-px bg-slate-700" aria-hidden="true" />
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-200">
              <Hash className="h-4 w-4 text-amber-300" aria-hidden="true" />
              <span>Numbers</span>
              <Switch
                checked={showCompartmentNumbers}
                onCheckedChange={handleShowCompartmentNumbersChange}
                disabled={showCalibration || !compartmentNumbersAreReady}
                aria-label="Show compartment numbers"
                aria-describedby={!compartmentNumbersAreReady ? `compartment-number-help-${case_.id}` : undefined}
                className="data-[state=checked]:bg-amber-500 data-[state=unchecked]:bg-slate-700"
              />
            </label>
            {!compartmentNumbersAreReady && (
              <span id={`compartment-number-help-${case_.id}`} className="sr-only">
                {mappingIsUnavailable
                  ? "Calibrate the case before showing compartment numbers."
                  : "Wait for compartment mapping to finish before showing numbers."}
              </span>
            )}
          </fieldset>

          <div>
            <span id={`component-scale-label-${case_.id}`} className="mb-1 block text-xs font-medium text-slate-400">
              Component scale
            </span>
            <div
              className="grid w-full grid-cols-2 rounded-lg border border-slate-700 bg-slate-950/70 p-1 sm:min-w-[18rem]"
              role="radiogroup"
              aria-labelledby={`component-scale-label-${case_.id}`}
              aria-describedby={`component-scale-description-${case_.id}`}
            >
              {COMPONENT_SCALE_MODES.map(({ mode, label }, modeIndex) => {
                const selected = componentScaleMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setComponentScaleMode(mode)}
                    onKeyDown={event => {
                      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                        return;
                      }
                      event.preventDefault();
                      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
                      const nextIndex = (
                        modeIndex + direction + COMPONENT_SCALE_MODES.length
                      ) % COMPONENT_SCALE_MODES.length;
                      setComponentScaleMode(COMPONENT_SCALE_MODES[nextIndex].mode);
                      requestAnimationFrame(() => {
                        document
                          .getElementById(`component-scale-${case_.id}-${COMPONENT_SCALE_MODES[nextIndex].mode}`)
                          ?.focus();
                      });
                    }}
                    id={`component-scale-${case_.id}-${mode}`}
                    className={`rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                      selected
                        ? "bg-indigo-500 text-white shadow-sm"
                        : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <span id={`component-scale-description-${case_.id}`} className="sr-only" aria-live="polite">
              {componentScaleMode === "display"
                ? `Each component's longest bounding-box edge is ${componentDisplaySizeMm} millimeters.`
                : "Components use the physical dimensions authored in each GLB."}
            </span>
          </div>

          {componentScaleMode === "display" && (
            <label className="block min-w-[8.5rem] text-xs font-medium text-slate-400">
              Longest edge
              <span className="mt-1 flex items-center gap-2 rounded-md border border-slate-700 bg-slate-950/70 px-2 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-400/30">
                <Input
                  type="number"
                  min="0.1"
                  max="1000"
                  step="0.1"
                  inputMode="decimal"
                  value={componentDisplaySizeDraft}
                  onChange={event => setComponentDisplaySizeDraft(event.target.value)}
                  onBlur={commitComponentDisplaySize}
                  onKeyDown={event => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitComponentDisplaySize();
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setComponentDisplaySizeDraft(String(componentDisplaySizeMm));
                      event.currentTarget.blur();
                    }
                  }}
                  aria-label="Component display size in millimeters"
                  className="h-9 border-0 bg-transparent px-1 text-right text-slate-100 shadow-none focus-visible:ring-0"
                />
                <span className="text-sm text-slate-400">mm</span>
              </span>
            </label>
          )}
        </div>
      </div>

      {showCalibration && (
        <aside
          className="rounded-xl border border-indigo-400/30 bg-slate-950/80 p-4"
          aria-labelledby="case-calibration-title"
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-indigo-300" aria-hidden="true" />
                <h4 id="case-calibration-title" className="font-semibold text-slate-100">
                  Calibrate {activeModel.label.toLowerCase()} compartment positions
                </h4>
              </div>
              <p className="mt-1 max-w-3xl text-sm text-slate-400">
                Pick the center of A1, the last compartment in row A, then the first
                compartment in the last row. Orbit the model between picks as needed.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowCalibration(false);
                setCalibrationPickMode(null);
              }}
              className="text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              Close
            </Button>
          </div>

          {!activeAssetId && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              This model is not a managed upload, so its calibration cannot be saved. Upload
              it again from Manage media first.
            </div>
          )}

          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {([
              ["origin", "1. Pick A1 center", calibrationPoints.origin],
              ["columnEnd", "2. Pick last column in row A", calibrationPoints.columnEnd],
              ["rowEnd", "3. Pick first column in last row", calibrationPoints.rowEnd],
            ] as const).map(([mode, label, point]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setCalibrationPickMode(mode)}
                className={`rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                  calibrationPickMode === mode
                    ? "border-indigo-400 bg-indigo-400/15"
                    : "border-slate-700 bg-slate-900 hover:border-slate-600"
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                  <Crosshair className="h-4 w-4 text-indigo-300" aria-hidden="true" />
                  {label}
                </span>
                <span className="mt-1 block font-mono text-xs text-slate-500">
                  {formatPoint(point)}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <label className="space-y-1 text-sm text-slate-300">
              <span className="font-medium">Meters per model unit</span>
              <input
                type="number"
                min="0"
                step="any"
                value={metersPerModelUnit}
                onChange={event => setMetersPerModelUnit(event.target.value)}
                className="h-10 w-full rounded-md border border-slate-600 bg-slate-900 px-3 text-slate-100 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30"
              />
              <span className="block text-xs text-slate-500">
                Usually 1 for GLB meters or 0.001 for millimeter-authored CAD.
              </span>
            </label>
            <label className="space-y-1 text-sm text-slate-300">
              <span className="font-medium">Rim offset in model units (optional)</span>
              <input
                type="number"
                step="any"
                value={rimOffset}
                onChange={event => setRimOffset(event.target.value)}
                placeholder="0"
                className="h-10 w-full rounded-md border border-slate-600 bg-slate-900 px-3 text-slate-100 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30"
              />
              <span className="block text-xs text-slate-500">
                Moves component placement along the outward normal.
              </span>
            </label>
            <div className="space-y-2 text-sm text-slate-300">
              <span className="font-medium">Outward direction</span>
              <Button
                type="button"
                variant="outline"
                className="w-full border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800 hover:text-white"
                onClick={() => setNormalDirection(current => current === 1 ? -1 : 1)}
              >
                {normalDirection === 1 ? "Use picked normal" : "Use flipped normal"}
              </Button>
              <span className="block text-xs text-slate-500">
                Flip this if previewed components appear behind the case surface.
              </span>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {activeCalibration && (
              <Button
                type="button"
                variant="outline"
                onClick={() => deleteCalibrationMutation.mutate()}
                disabled={isSavingCalibration}
                className="border-red-400/40 bg-red-400/10 text-red-100 hover:bg-red-400/20 hover:text-white"
              >
                Remove calibration
              </Button>
            )}
            <Button
              type="button"
              onClick={() => calibrationCandidate && saveCalibrationMutation.mutate(calibrationCandidate)}
              disabled={!calibrationCandidate || isSavingCalibration}
              className="gap-2"
            >
              {isSavingCalibration ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Save className="h-4 w-4" aria-hidden="true" />
              )}
              Save calibration
            </Button>
          </div>
        </aside>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div
          id={`case-3d-${case_.id}-model-panel`}
          aria-label={`${case_.name} open 3D assembly`}
          className="min-h-[520px] overflow-hidden rounded-xl border border-slate-700 bg-slate-950"
        >
          <Suspense
            fallback={(
              <div className="flex h-[clamp(520px,68vh,780px)] items-center justify-center text-sm text-slate-400">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Loading 3D workspace…
              </div>
            )}
          >
            <CaseInventoryScene
              ref={sceneRef}
              key={case_.id}
              case_={case_}
              caseModels={sceneModels}
              calibrationLayer={activeLayer}
              visibleCompartmentIds={visibleCompartmentIds}
              priorityCompartmentIds={priorityCompartmentIds}
              selectedCompartmentId={selectedEntry?.id || null}
              componentScaleMode={componentScaleMode}
              componentDisplaySizeMeters={componentDisplaySizeMm / 1000}
              showCaseModel={showCaseModel}
              showCompartmentNumbers={showCompartmentNumbers}
              calibrationActive={showCalibration}
              calibrationPickMode={showCalibration ? calibrationPickMode : null}
              onCalibrationPick={handleCalibrationPick}
              onSelectCompartment={onSelectCompartment}
              onOpenComponent={onOpenComponent}
              onMappingStatus={handleMappingStatus}
              onFailure={onFailure}
              className="h-[clamp(520px,68vh,780px)] w-full"
            />
          </Suspense>
        </div>

        <aside className="flex min-h-0 flex-col rounded-xl border border-slate-700 bg-slate-950/70">
          <div className="border-b border-slate-700 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="font-semibold text-slate-100">
                  {searchIsActive
                    ? companionIncludesNonmatchingSelection
                      ? "Matches and selection"
                      : "Matching compartments"
                    : "Compartment inventory"}
                </h4>
                <p className="mt-1 text-xs text-slate-500">
                  {searchIsActive
                    ? `${matchingEntries.length} ${matchingEntries.length === 1 ? "component" : "components"} matching “${searchQuery.trim()}”${
                        companionIncludesNonmatchingSelection ? ", plus the current selection" : ""
                      }`
                    : `${companionEntries.length} ${companionEntries.length === 1 ? "component" : "components"} across the whole case`}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-slate-300 hover:bg-slate-800 hover:text-white"
                  onClick={() => moveSelection(-1)}
                  disabled={navigationEntries.length === 0}
                  aria-label="Previous component"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-slate-300 hover:bg-slate-800 hover:text-white"
                  onClick={() => moveSelection(1)}
                  disabled={navigationEntries.length === 0}
                  aria-label="Next component"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          </div>

          <div className="max-h-[clamp(440px,60vh,700px)] overflow-y-auto p-2">
            {companionEntries.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-500">
                {searchIsActive
                  ? "No components in this case match the search."
                  : "No populated compartments in this case."}
              </div>
            ) : (
              <ol className="space-y-1" aria-label="Whole-case compartment inventory">
                {companionEntries.map(entry => {
                  const selected = entry.component.id === selectedComponentId;
                  return (
                    <li
                      key={entry.id}
                      className={`group flex items-stretch gap-1 rounded-lg border p-1 transition-colors ${
                        selected
                          ? "border-indigo-400/60 bg-indigo-400/15"
                          : "border-transparent hover:border-slate-700 hover:bg-slate-900"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => selectEntry(entry)}
                        className="min-w-0 flex-1 rounded-md px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                        aria-current={selected ? "true" : undefined}
                      >
                        <span className="flex items-center gap-2">
                          <MapPin
                            className={`h-4 w-4 shrink-0 ${selected ? "text-indigo-300" : "text-slate-500"}`}
                            aria-hidden="true"
                          />
                          <span className="font-mono text-xs font-semibold text-indigo-200">
                            {entry.position}
                          </span>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            {entry.layer === "bottom" ? "Bottom" : "Top"}
                          </span>
                          <span className="truncate text-sm font-medium text-slate-100">
                            {entry.component.name}
                          </span>
                        </span>
                        <span className="mt-1 block truncate pl-6 text-xs text-slate-500">
                          {entry.component.packageSize || "No package"} · Qty {entry.component.quantity}
                          {entry.component.model3dUrl ? " · 3D model" : " · Location only"}
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenComponent(entry.component.id)}
                        className="self-center text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
                        aria-label={`Open details for ${entry.component.name}`}
                      >
                        Details
                      </Button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </aside>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-slate-500">
        <Box className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {models.map(model => (
          <span key={model.layer} className="truncate" title={model.name}>
            {model.label}: {model.name}
          </span>
        ))}
      </div>
    </section>
  );
}
