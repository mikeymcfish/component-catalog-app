import { useEffect, useState } from "react";
import CompartmentCell from "./compartment-cell";
import { COMPONENT_CATEGORIES } from "@/lib/constants";
import { getPositionLabel, getRowLabel } from "@/lib/compartment-labels";
import { UNSORTED_CASE_MODEL } from "@shared/case-layouts";
import {
  safeParseCustomCaseLayout,
  type CustomCaseLayerName,
} from "@shared/custom-case-layout";
import type { CaseWithCompartments, Compartment, Component } from "@shared/schema";

interface CaseGridProps {
  case_: CaseWithCompartments;
  onCompartmentClick: (compartment: Compartment, component?: Component) => void;
  searchQuery?: string;
  interactionMode?: "view" | "edit";
  hasCopiedComponent?: boolean;
  copiedComponentId?: number;
  onCopyCompartment?: (component: Component) => void;
  onPasteCompartment?: (compartment: Compartment, component?: Component) => void;
}

export default function CaseGrid({
  case_,
  onCompartmentClick,
  searchQuery = "",
  interactionMode = "edit",
  hasCopiedComponent = false,
  copiedComponentId,
  onCopyCompartment,
  onPasteCompartment,
}: CaseGridProps) {
  const [revealedCompartmentIds, setRevealedCompartmentIds] = useState<Set<number>>(
    () => new Set(),
  );

  useEffect(() => {
    setRevealedCompartmentIds(new Set());
  }, [case_.id, interactionMode]);

  const revealCompartment = (compartment: Compartment) => {
    const populatedCompartment = compartment as Compartment & { component?: Component };
    if (interactionMode !== "view" || !populatedCompartment.component) return;

    setRevealedCompartmentIds((current) => {
      if (current.has(compartment.id)) return current;

      const next = new Set(current);
      next.add(compartment.id);
      return next;
    });
  };

  const getCaseLayout = (caseData: CaseWithCompartments) => {
    const layouts: Record<string, { rows: number; cols: number; description: string; isMixed?: boolean; isTall?: boolean }> = {
      "LAYOUT-12x6-BOTH": {
        rows: 6,
        cols: 12,
        description: "12×6 Both Layers (uniform squares)"
      },
      "LAYOUT-6x4-TOP": {
        rows: 4,
        cols: 6,
        description: "6×4 Top + 12×6 Bottom (mixed)",
        isMixed: true
      },
      "LAYOUT-6x4-BOTH": {
        rows: 4,
        cols: 6,
        description: "6×4 Both Layers (tall rectangles)",
        isTall: true
      },
      // Legacy support
      "BOX-ALL-144": { rows: 6, cols: 12, description: "Legacy BOX-ALL-144" },
      "BOX-ALL-96": { rows: 6, cols: 12, description: "Legacy BOX-ALL-96" },
      "BOX-ALL-48": { rows: 4, cols: 6, description: "Legacy BOX-ALL-48" },
      "BOX-ALL-24": { rows: 2, cols: 6, description: "Legacy BOX-ALL-24" },
      "LAYOUT-MIXED": { rows: 4, cols: 6, description: "Mixed Layout", isMixed: true }
    };
    return layouts[caseData.model] || {
      rows: caseData.rows,
      cols: caseData.cols,
      description: caseData.model === UNSORTED_CASE_MODEL
        ? "Temporary holding area"
        : `${caseData.cols}x${caseData.rows}${caseData.hasBottom ? " both layers" : ""}`,
    };
  };

  const layout = getCaseLayout(case_);
  const topCompartments = case_.compartments.filter(comp => comp.layer === "top");
  const bottomCompartments = case_.compartments.filter(comp => comp.layer === "bottom");
  const categoryById = new Map(
    COMPONENT_CATEGORIES.map((category, index) => [index + 1, category])
  );

  const customLayoutResult = case_.model.startsWith("CUSTOM-")
    ? safeParseCustomCaseLayout(case_.layoutGeometry, {
        rows: case_.rows,
        cols: case_.cols,
        hasBottom: Boolean(case_.hasBottom),
      })
    : null;
  const customLayout = customLayoutResult?.success ? customLayoutResult.data : null;

  const componentMatchesSearch = (component: Component | undefined) => {
    if (!searchQuery) return true;
    if (!component) return false;
    const normalizedQuery = searchQuery.toLowerCase();
    const category = categoryById.get(component.categoryId);
    return (
      component.name.toLowerCase().includes(normalizedQuery) ||
      (category?.value.toLowerCase().includes(normalizedQuery) ?? false) ||
      (category?.label.toLowerCase().includes(normalizedQuery) ?? false) ||
      (component.packageSize?.toLowerCase().includes(normalizedQuery) ?? false) ||
      (component.notes?.toLowerCase().includes(normalizedQuery) ?? false)
    );
  };

  const renderCustomLayer = (
    compartments: Array<Compartment & { component?: Component }>,
    layerName: string,
    layerKey: CustomCaseLayerName,
  ) => {
    const geometry = customLayout?.layers[layerKey];
    if (!geometry) return null;

    return (
      <div
        className="physical-case-layer custom-physical-case-layer scroll-mt-24 space-y-4"
        data-case-id={case_.id}
        data-case-layer={layerKey}
      >
        <h3 className="physical-case-layer-title flex items-center text-lg font-semibold text-gray-700">
          {layerName}
          <span className="ml-2 text-sm text-gray-500">(Custom compartment layout)</span>
        </h3>
        <div className="overflow-x-auto pb-2">
          <div
            className="custom-physical-case-grid"
            style={{
              gridTemplateRows: geometry.rowHeights.map(height => `${height}fr`).join(" "),
              minWidth: `${Math.max(760, case_.cols * 64)}px`,
              height: `${Math.max(360, case_.rows * 64)}px`,
            }}
          >
            {geometry.columnWidthsByRow.map((widths, rowIndex) => (
              <div
                key={`${layerKey}-custom-row-${rowIndex}`}
                className="custom-physical-case-row"
                style={{ gridTemplateColumns: widths.map(width => `${width}fr`).join(" ") }}
              >
                {widths.map((_width, colIndex) => {
                  const position = getPositionLabel(rowIndex + 1, colIndex + 1);
                  const candidate = compartments.find(compartment =>
                    compartment.row === rowIndex + 1 && compartment.col === colIndex + 1
                  );
                  const compartment = candidate && componentMatchesSearch(candidate.component)
                    ? candidate
                    : searchQuery ? undefined : candidate;
                  const isHighlighted = !searchQuery || Boolean(compartment);

                  return (
                    <div key={`${layerKey}-${position}`} className="physical-case-bin-slot custom-physical-case-bin-slot">
                      <CompartmentCell
                        compartment={compartment}
                        position={position}
                        onClick={() => {
                          if (!compartment) return;
                          revealCompartment(compartment);
                          onCompartmentClick(compartment, compartment.component);
                        }}
                        revealComponent={!!compartment && revealedCompartmentIds.has(compartment.id)}
                        isHighlighted={isHighlighted}
                        interactionMode={interactionMode}
                        hasCopiedComponent={hasCopiedComponent}
                        copiedComponentId={copiedComponentId}
                        onCopy={onCopyCompartment}
                        onPaste={onPasteCompartment}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderLayer = (compartments: any[], layerName: string) => {
    const customLayerKey: CustomCaseLayerName = layerName === "Bottom Layer" ? "bottom" : "top";
    if (customLayout?.layers[customLayerKey]) {
      return renderCustomLayer(compartments, layerName, customLayerKey);
    }

    // Determine grid dimensions based on layout and layer
    let gridRows = layout.rows;
    let gridCols = layout.cols;

    if (layout.isMixed && layerName === "Bottom Layer") {
      // For mixed layout, bottom layer is 12x6
      gridRows = 6;
      gridCols = 12;
    }

    // Filter compartments based on search query
    const searchFilteredCompartments = searchQuery
      ? compartments.filter(comp => {
          if (!comp.component) return false;
          const component = comp.component;
          return componentMatchesSearch(component);
        })
      : compartments;

    const columnLabels = Array.from({ length: gridCols }, (_, colIndex) => colIndex + 1);
    const rowLabels = Array.from({ length: gridRows }, (_, rowIndex) => getRowLabel(rowIndex + 1));

    return (
      <div
        className="physical-case-layer scroll-mt-24 space-y-4"
        data-case-id={case_.id}
        data-case-layer={customLayerKey}
      >
        <h3 className="physical-case-layer-title text-lg font-semibold text-gray-700 flex items-center">
          {layerName}
          {layout.isTall && (
            <span className="ml-2 text-sm text-gray-500">(All tall rectangles)</span>
          )}
          {layout.isMixed && layerName === "Top Layer" && (
            <span className="ml-2 text-sm text-gray-500">(Rows 1-2: Long, Rows 3-4: Tall)</span>
          )}
          {layout.isMixed && layerName === "Bottom Layer" && (
            <span className="ml-2 text-sm text-gray-500">(All square compartments)</span>
          )}
        </h3>
        <div className="overflow-x-auto pb-2">
          <div
            className="physical-case-grid grid gap-1 max-w-4xl mx-auto"
            style={{
              gridTemplateColumns: `2rem repeat(${gridCols}, minmax(0, 1fr))`,
              minWidth: gridCols >= 12 ? "760px" : "460px",
            }}
          >
            <div className="h-6" aria-hidden="true" />
            {columnLabels.map((col) => (
              <div
                key={`${layerName}-col-${col}`}
                className="physical-case-axis-label physical-case-axis-label--column flex h-6 items-center justify-center rounded bg-gray-100 text-xs font-semibold text-gray-600"
              >
                {col}
              </div>
            ))}

            {Array.from({ length: gridRows }, (_, rowIndex) => {
              const rowLabel = rowLabels[rowIndex];

              return [
                <div
                  key={`${layerName}-row-${rowLabel}`}
                  className="physical-case-axis-label physical-case-axis-label--row flex items-center justify-center rounded bg-gray-100 text-xs font-semibold text-gray-600"
                >
                  {rowLabel}
                </div>,
                ...Array.from({ length: gridCols }, (_, colIndex) => {
                  const position = getPositionLabel(rowIndex + 1, colIndex + 1);
                  const compartment = searchQuery
                    ? searchFilteredCompartments.find(c => c.position === position)
                    : compartments.find(c => c.position === position);

                  const isHighlighted = !searchQuery || (compartment && searchFilteredCompartments.includes(compartment));

                  // Determine aspect ratio based on layout type and row position
                  let cellClass = "";
                  if (layout.isTall) {
                    // 6x4 Both Layers - all tall rectangles
                    cellClass = "aspect-[1/2]";
                  } else if (layout.isMixed) {
                    // 6x4 Top + 12x6 Bottom - mixed based on layer
                    if (layerName === "Top Layer") {
                      // Top layer (6x4): first 2 rows long, last 2 rows tall
                      if (rowIndex < 2) {
                        cellClass = "aspect-[2/1]"; // Long rectangles for first 2 rows
                      } else {
                        cellClass = "aspect-[1/2]"; // Tall rectangles for last 2 rows
                      }
                    } else {
                      // Bottom layer (12x6): all squares
                      cellClass = "aspect-square";
                    }
                  } else {
                    // 12x6 Both Layers - all squares
                    cellClass = "aspect-square";
                  }

                  return (
                    <div key={`${layerName}-${position}`} className={`physical-case-bin-slot ${cellClass}`}>
                      <CompartmentCell
                        compartment={compartment}
                        position={position}
                        onClick={() => {
                          if (compartment) {
                            revealCompartment(compartment);
                            onCompartmentClick(compartment, compartment.component);
                          }
                        }}
                        revealComponent={
                          !!compartment && revealedCompartmentIds.has(compartment.id)
                        }
                        isHighlighted={isHighlighted}
                        interactionMode={interactionMode}
                        hasCopiedComponent={hasCopiedComponent}
                        copiedComponentId={copiedComponentId}
                        onCopy={onCopyCompartment}
                        onPaste={onPasteCompartment}
                      />
                    </div>
                  );
                }),
              ];
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`physical-case-shell physical-case-shell--${interactionMode} bg-white rounded-xl shadow-sm border border-gray-200 p-8 space-y-8`}>
      {/* Top Layer */}
      {renderLayer(topCompartments, "Top Layer")}

      {bottomCompartments.length > 0 && (
        <>
          {/* Visual Divider */}
          <div className="physical-case-separator relative">
            <div className="absolute inset-0 flex items-center">
              <div className="physical-case-separator-line w-full border-t border-gray-300"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="physical-case-separator-label px-3 bg-white text-gray-500">Case Separator</span>
            </div>
          </div>

          {/* Bottom Layer */}
          {renderLayer(bottomCompartments, "Bottom Layer")}
        </>
      )}

      {/* Legend / view-mode guidance */}
      {interactionMode === "view" ? (
        <div className="physical-case-view-hint">
          Compartment text stays visible. Select a bin to reveal its visual and open full details.
        </div>
      ) : (
      <div className="physical-case-legend mt-6 flex items-center justify-center space-x-6 text-sm">
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 bg-green-50 border-2 border-green-300 rounded"></div>
          <span className="text-gray-600">In Stock (10+)</span>
        </div>
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 bg-yellow-50 border-2 border-yellow-300 rounded"></div>
          <span className="text-gray-600">Low Stock (5-9)</span>
        </div>
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 bg-red-50 border-2 border-red-300 rounded"></div>
          <span className="text-gray-600">Critical (1-4)</span>
        </div>
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 bg-gray-50 border-2 border-dashed border-gray-300 rounded"></div>
          <span className="text-gray-600">Empty</span>
        </div>
      </div>
      )}
    </div>
  );
}
