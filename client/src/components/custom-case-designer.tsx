import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Copy, Magnet, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CUSTOM_CASE_LAYOUT_MIN_TRACK,
  CUSTOM_CASE_LAYOUT_UNITS,
  cloneCustomCaseLayout,
  cloneCustomCaseLayer,
  createUniformCustomCaseLayout,
  createUniformCustomCaseLayer,
  getCustomCaseTrackBoundary,
  replaceCustomCaseLayer,
  resizeCustomCaseColumnBoundary,
  resizeCustomCaseRowBoundary,
  safeParseCustomCaseLayout,
  type CustomCaseLayerGeometry,
  type CustomCaseLayerName,
  type CustomCaseLayoutGeometry,
} from "@shared/custom-case-layout";

const SNAP_ENTER_PIXELS = 8;
const SNAP_RELEASE_PIXELS = 14;
const KEYBOARD_STEP = 100;
const KEYBOARD_LARGE_STEP = 500;

interface CustomCaseDesignerProps {
  rows: number;
  cols: number;
  hasBottom: boolean;
  value: CustomCaseLayoutGeometry;
  onChange: (layout: CustomCaseLayoutGeometry) => void;
  disabled?: boolean;
}

interface SnapGuide {
  position: number;
  sourceRow: number;
}

interface ColumnDrag {
  kind: "column";
  pointerId: number;
  layerName: CustomCaseLayerName;
  rowIndex: number;
  dividerIndex: number;
  startClient: number;
  extentPixels: number;
  startBoundary: number;
  snapTarget?: number;
  snapped: boolean;
  startLayout: CustomCaseLayoutGeometry;
  startLayer: CustomCaseLayerGeometry;
}

interface RowDrag {
  kind: "row";
  pointerId: number;
  layerName: CustomCaseLayerName;
  dividerIndex: number;
  startClient: number;
  extentPixels: number;
  startBoundary: number;
  startLayout: CustomCaseLayoutGeometry;
  startLayer: CustomCaseLayerGeometry;
}

type ActiveDrag = ColumnDrag | RowDrag;

function getLayer(
  layout: CustomCaseLayoutGeometry,
  layerName: CustomCaseLayerName,
) {
  return layerName === "top"
    ? layout.layers.top
    : layout.layers.bottom ?? layout.layers.top;
}

function sumTracks(tracks: readonly number[], endIndex: number) {
  let total = 0;
  for (let index = 0; index < endIndex; index += 1) total += tracks[index];
  return total;
}

function getBoundaryRange(tracks: readonly number[], dividerIndex: number) {
  const pairStart = sumTracks(tracks, dividerIndex - 1);
  const pairEnd = pairStart + tracks[dividerIndex - 1] + tracks[dividerIndex];

  return {
    minimum: pairStart + CUSTOM_CASE_LAYOUT_MIN_TRACK,
    maximum: pairEnd - CUSTOM_CASE_LAYOUT_MIN_TRACK,
  };
}

function percent(units: number) {
  return `${(units / CUSTOM_CASE_LAYOUT_UNITS) * 100}%`;
}

function rowLabel(rowIndex: number) {
  return String.fromCharCode(65 + rowIndex);
}

export default function CustomCaseDesigner({
  rows,
  cols,
  hasBottom,
  value,
  onChange,
  disabled = false,
}: CustomCaseDesignerProps) {
  const [activeLayer, setActiveLayer] = useState<CustomCaseLayerName>("top");
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapGuide, setSnapGuide] = useState<SnapGuide | null>(null);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ActiveDrag | null>(null);

  const fallbackLayout = useMemo(
    () => createUniformCustomCaseLayout(rows, cols, hasBottom),
    [rows, cols, hasBottom],
  );
  const validation = useMemo(
    () => safeParseCustomCaseLayout(value, { rows, cols, hasBottom }),
    [value, rows, cols, hasBottom],
  );
  const layout = validation.success ? validation.data : fallbackLayout;
  const layer = getLayer(layout, activeLayer);

  useEffect(() => {
    if (!hasBottom && activeLayer === "bottom") setActiveLayer("top");
  }, [activeLayer, hasBottom]);

  useEffect(() => {
    dragRef.current = null;
    setSnapGuide(null);
    setActiveHandle(null);
  }, [rows, cols, hasBottom, activeLayer]);

  const finishDrag = (pointerId?: number) => {
    if (pointerId !== undefined && dragRef.current?.pointerId !== pointerId) return;
    dragRef.current = null;
    setSnapGuide(null);
    setActiveHandle(null);
  };

  const beginColumnDrag = (
    event: PointerEvent<HTMLButtonElement>,
    rowIndex: number,
    dividerIndex: number,
  ) => {
    if (disabled) return;

    const rowElement = event.currentTarget.closest<HTMLElement>("[data-custom-case-row]");
    if (!rowElement) return;

    const rowBounds = rowElement.getBoundingClientRect();
    if (rowBounds.width <= 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startLayout = cloneCustomCaseLayout(layout);
    const startLayer = cloneCustomCaseLayer(getLayer(startLayout, activeLayer));
    const widths = startLayer.columnWidthsByRow[rowIndex];
    const snapTarget = rowIndex > 0
      ? getCustomCaseTrackBoundary(
          startLayer.columnWidthsByRow[rowIndex - 1],
          dividerIndex,
        )
      : undefined;

    dragRef.current = {
      kind: "column",
      pointerId: event.pointerId,
      layerName: activeLayer,
      rowIndex,
      dividerIndex,
      startClient: event.clientX,
      extentPixels: rowBounds.width,
      startBoundary: getCustomCaseTrackBoundary(widths, dividerIndex),
      snapTarget,
      snapped: false,
      startLayout,
      startLayer,
    };
    setActiveHandle(`column-${rowIndex}-${dividerIndex}`);
  };

  const beginRowDrag = (
    event: PointerEvent<HTMLButtonElement>,
    dividerIndex: number,
  ) => {
    if (disabled || !canvasRef.current) return;

    const canvasBounds = canvasRef.current.getBoundingClientRect();
    if (canvasBounds.height <= 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startLayout = cloneCustomCaseLayout(layout);
    const startLayer = cloneCustomCaseLayer(getLayer(startLayout, activeLayer));

    dragRef.current = {
      kind: "row",
      pointerId: event.pointerId,
      layerName: activeLayer,
      dividerIndex,
      startClient: event.clientY,
      extentPixels: canvasBounds.height,
      startBoundary: getCustomCaseTrackBoundary(startLayer.rowHeights, dividerIndex),
      startLayout,
      startLayer,
    };
    setActiveHandle(`row-${dividerIndex}`);
    setSnapGuide(null);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || disabled) return;

    event.preventDefault();

    if (drag.kind === "column") {
      const delta = ((event.clientX - drag.startClient) / drag.extentPixels)
        * CUSTOM_CASE_LAYOUT_UNITS;
      const rawBoundary = drag.startBoundary + delta;
      let requestedBoundary = rawBoundary;

      if (
        snapEnabled
        && !event.altKey
        && drag.snapTarget !== undefined
      ) {
        const distancePixels = Math.abs(rawBoundary - drag.snapTarget)
          / CUSTOM_CASE_LAYOUT_UNITS
          * drag.extentPixels;

        if (drag.snapped) {
          if (distancePixels <= SNAP_RELEASE_PIXELS) {
            requestedBoundary = drag.snapTarget;
          } else {
            drag.snapped = false;
          }
        } else if (distancePixels <= SNAP_ENTER_PIXELS) {
          drag.snapped = true;
          requestedBoundary = drag.snapTarget;
        }
      } else {
        drag.snapped = false;
      }

      setSnapGuide(
        drag.snapped && drag.snapTarget !== undefined
          ? { position: drag.snapTarget, sourceRow: drag.rowIndex - 1 }
          : null,
      );

      const nextLayer = resizeCustomCaseColumnBoundary(
        drag.startLayer,
        drag.rowIndex,
        drag.dividerIndex,
        requestedBoundary,
      );
      onChange(replaceCustomCaseLayer(drag.startLayout, drag.layerName, nextLayer));
      return;
    }

    const delta = ((event.clientY - drag.startClient) / drag.extentPixels)
      * CUSTOM_CASE_LAYOUT_UNITS;
    const nextLayer = resizeCustomCaseRowBoundary(
      drag.startLayer,
      drag.dividerIndex,
      drag.startBoundary + delta,
    );
    onChange(replaceCustomCaseLayer(drag.startLayout, drag.layerName, nextLayer));
  };

  const handlePointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishDrag(event.pointerId);
  };

  const updateColumnFromKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    rowIndex: number,
    dividerIndex: number,
  ) => {
    if (disabled) return;

    const widths = layer.columnWidthsByRow[rowIndex];
    const currentBoundary = getCustomCaseTrackBoundary(widths, dividerIndex);
    const range = getBoundaryRange(widths, dividerIndex);
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    let requestedBoundary: number | undefined;

    if (event.key === "ArrowLeft") requestedBoundary = currentBoundary - step;
    if (event.key === "ArrowRight") requestedBoundary = currentBoundary + step;
    if (event.key === "Home") requestedBoundary = range.minimum;
    if (event.key === "End") requestedBoundary = range.maximum;
    if (requestedBoundary === undefined) return;

    event.preventDefault();

    if (snapEnabled && !event.altKey && rowIndex > 0) {
      const snapTarget = getCustomCaseTrackBoundary(
        layer.columnWidthsByRow[rowIndex - 1],
        dividerIndex,
      );
      const rowWidth = event.currentTarget
        .closest<HTMLElement>("[data-custom-case-row]")
        ?.getBoundingClientRect().width;
      const snapDistance = rowWidth
        ? SNAP_ENTER_PIXELS / rowWidth * CUSTOM_CASE_LAYOUT_UNITS
        : KEYBOARD_STEP;

      if (Math.abs(requestedBoundary - snapTarget) <= snapDistance) {
        requestedBoundary = snapTarget;
        setSnapGuide({ position: snapTarget, sourceRow: rowIndex - 1 });
      } else {
        setSnapGuide(null);
      }
    } else {
      setSnapGuide(null);
    }

    const nextLayer = resizeCustomCaseColumnBoundary(
      layer,
      rowIndex,
      dividerIndex,
      requestedBoundary,
    );
    onChange(replaceCustomCaseLayer(layout, activeLayer, nextLayer));
  };

  const updateRowFromKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    dividerIndex: number,
  ) => {
    if (disabled) return;

    const currentBoundary = getCustomCaseTrackBoundary(layer.rowHeights, dividerIndex);
    const range = getBoundaryRange(layer.rowHeights, dividerIndex);
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    let requestedBoundary: number | undefined;

    if (event.key === "ArrowUp") requestedBoundary = currentBoundary - step;
    if (event.key === "ArrowDown") requestedBoundary = currentBoundary + step;
    if (event.key === "Home") requestedBoundary = range.minimum;
    if (event.key === "End") requestedBoundary = range.maximum;
    if (requestedBoundary === undefined) return;

    event.preventDefault();
    setSnapGuide(null);
    const nextLayer = resizeCustomCaseRowBoundary(
      layer,
      dividerIndex,
      requestedBoundary,
    );
    onChange(replaceCustomCaseLayer(layout, activeLayer, nextLayer));
  };

  const resetActiveLayer = () => {
    if (disabled) return;
    onChange(
      replaceCustomCaseLayer(
        layout,
        activeLayer,
        createUniformCustomCaseLayer(rows, cols),
      ),
    );
    setSnapGuide(null);
  };

  const copyTopToBottom = () => {
    if (disabled || !hasBottom) return;
    onChange(replaceCustomCaseLayer(layout, "bottom", layout.layers.top));
    setActiveLayer("bottom");
    setSnapGuide(null);
  };

  const canvasWidth = Math.max(720, cols * 64);
  const canvasHeight = Math.max(360, rows * 48);

  return (
    <section className="custom-case-designer space-y-4" aria-label="Custom case layout designer">
      <div className="custom-case-designer__toolbar flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={activeLayer}
          onValueChange={(nextLayer) => setActiveLayer(nextLayer as CustomCaseLayerName)}
        >
          <TabsList>
            <TabsTrigger value="top" disabled={disabled}>Top</TabsTrigger>
            {hasBottom && (
              <TabsTrigger value="bottom" disabled={disabled}>Bottom</TabsTrigger>
            )}
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={snapEnabled ? "secondary" : "outline"}
            onClick={() => {
              setSnapEnabled((enabled) => !enabled);
              setSnapGuide(null);
            }}
            disabled={disabled}
            aria-pressed={snapEnabled}
          >
            <Magnet className="mr-1.5 h-4 w-4" />
            Snap {snapEnabled ? "on" : "off"}
          </Button>
          {hasBottom && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={copyTopToBottom}
              disabled={disabled}
            >
              <Copy className="mr-1.5 h-4 w-4" />
              Copy top to bottom
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={resetActiveLayer}
            disabled={disabled}
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Reset {activeLayer}
          </Button>
        </div>
      </div>

      <p className="custom-case-designer__instructions text-sm text-muted-foreground">
        Drag a divider to resize its two neighboring compartments. Vertical dividers softly
        align with the row above; keep dragging past the guide, hold Alt, or turn Snap off to
        override it. Focus a divider and use the arrow keys for precise changes (Shift for 5%).
      </p>

      {!validation.success && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
          The saved layout does not match these dimensions. A uniform layout is shown until
          the next edit.
        </p>
      )}

      <div className="custom-case-designer__viewport overflow-auto rounded-xl border border-slate-300 bg-slate-100 p-4 shadow-inner">
        <div
          ref={canvasRef}
          className="custom-case-designer__canvas relative flex flex-col overflow-visible rounded-lg border-4 border-slate-700 bg-slate-700 shadow-lg"
          style={{ width: canvasWidth, height: canvasHeight }}
        >
          {snapGuide && (
            <div
              className="custom-case-designer__snap-guide pointer-events-none absolute inset-y-0 z-50 w-0 border-l-2 border-dashed border-sky-400 drop-shadow-[0_0_3px_rgba(56,189,248,0.9)]"
              style={{ left: percent(snapGuide.position) }}
              aria-hidden="true"
            >
              <span className="absolute left-1 top-1 rounded bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">
                aligns with {rowLabel(snapGuide.sourceRow)}
              </span>
            </div>
          )}

          {layer.rowHeights.map((height, rowIndex) => {
            const widths = layer.columnWidthsByRow[rowIndex];

            return (
              <div
                key={`${activeLayer}-row-${rowIndex}`}
                data-custom-case-row
                className="custom-case-designer__row relative flex shrink-0"
                style={{ height: percent(height) }}
              >
                {widths.map((width, colIndex) => {
                  const dividerIndex = colIndex + 1;
                  const hasDivider = dividerIndex < widths.length;
                  const boundary = hasDivider
                    ? getCustomCaseTrackBoundary(widths, dividerIndex)
                    : CUSTOM_CASE_LAYOUT_UNITS;
                  const range = hasDivider
                    ? getBoundaryRange(widths, dividerIndex)
                    : null;
                  const leftPercent = width / 100;
                  const rightPercent = hasDivider ? widths[colIndex + 1] / 100 : 0;
                  const handleId = `column-${rowIndex}-${dividerIndex}`;

                  return (
                    <div
                      key={`${activeLayer}-${rowIndex}-${colIndex}`}
                      className="custom-case-designer__compartment relative flex min-h-0 shrink-0 items-center justify-center overflow-visible border border-slate-500 bg-slate-800 text-slate-100"
                      style={{ width: percent(width) }}
                    >
                      <div className="pointer-events-none flex max-w-full flex-col items-center px-1 text-center">
                        <span className="text-xs font-semibold">
                          {rowLabel(rowIndex)}{colIndex + 1}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {leftPercent.toFixed(1)}% × {(height / 100).toFixed(1)}%
                        </span>
                      </div>

                      {hasDivider && range && (
                        <button
                          type="button"
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`Resize ${rowLabel(rowIndex)}${colIndex + 1} and ${rowLabel(rowIndex)}${colIndex + 2} widths`}
                          aria-valuemin={range.minimum}
                          aria-valuemax={range.maximum}
                          aria-valuenow={boundary}
                          aria-valuetext={`${leftPercent.toFixed(1)} percent and ${rightPercent.toFixed(1)} percent wide`}
                          className={`custom-case-designer__column-divider absolute -right-3 bottom-3 top-3 z-30 w-6 touch-none cursor-col-resize rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                            activeHandle === handleId ? "bg-sky-400/15" : "hover:bg-sky-400/10"
                          }`}
                          onPointerDown={(event) => beginColumnDrag(event, rowIndex, dividerIndex)}
                          onPointerMove={handlePointerMove}
                          onPointerUp={handlePointerEnd}
                          onPointerCancel={handlePointerEnd}
                          onLostPointerCapture={(event) => finishDrag(event.pointerId)}
                          onKeyDown={(event) => updateColumnFromKeyboard(event, rowIndex, dividerIndex)}
                          disabled={disabled}
                        >
                          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-slate-400 transition-colors group-hover:bg-sky-400" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {rowIndex < layer.rowHeights.length - 1 && (() => {
                  const dividerIndex = rowIndex + 1;
                  const boundary = getCustomCaseTrackBoundary(layer.rowHeights, dividerIndex);
                  const range = getBoundaryRange(layer.rowHeights, dividerIndex);
                  const handleId = `row-${dividerIndex}`;

                  return (
                    <button
                      type="button"
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label={`Resize rows ${rowLabel(rowIndex)} and ${rowLabel(rowIndex + 1)} heights`}
                      aria-valuemin={range.minimum}
                      aria-valuemax={range.maximum}
                      aria-valuenow={boundary}
                      aria-valuetext={`${(height / 100).toFixed(1)} percent and ${(layer.rowHeights[rowIndex + 1] / 100).toFixed(1)} percent high`}
                      className={`custom-case-designer__row-divider absolute -bottom-3 left-3 right-3 z-40 h-6 touch-none cursor-row-resize rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                        activeHandle === handleId ? "bg-sky-400/15" : "hover:bg-sky-400/10"
                      }`}
                      onPointerDown={(event) => beginRowDrag(event, dividerIndex)}
                      onPointerMove={handlePointerMove}
                      onPointerUp={handlePointerEnd}
                      onPointerCancel={handlePointerEnd}
                      onLostPointerCapture={(event) => finishDrag(event.pointerId)}
                      onKeyDown={(event) => updateRowFromKeyboard(event, dividerIndex)}
                      disabled={disabled}
                    >
                      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-slate-400 transition-colors" />
                    </button>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export type { CustomCaseDesignerProps };
