import { Badge } from "@/components/ui/badge";
import { formatCompartmentLocation, getRowLabel } from "@/lib/compartment-labels";
import { UNORGANIZED_CASE_MODEL, UNSORTED_CASE_MODEL } from "@shared/case-layouts";
import type { CaseWithCompartments, Component } from "@shared/schema";

interface CaseThumbnailProps {
  case_: CaseWithCompartments;
  matchingComponents: Component[];
  onClick: () => void;
}

export default function CaseThumbnail({ case_, matchingComponents, onClick }: CaseThumbnailProps) {
  const getCaseLayout = (caseData: CaseWithCompartments) => {
    const layouts: Record<string, { rows: number; cols: number; description: string; isMixed?: boolean; isTall?: boolean }> = {
      "LAYOUT-12x6-BOTH": {
        rows: 6,
        cols: 12,
        description: "12×6 Both Layers"
      },
      "LAYOUT-6x4-TOP": {
        rows: 4,
        cols: 6,
        description: "6×4 Top + 12×6 Bottom",
        isMixed: true
      },
      "LAYOUT-6x4-BOTH": {
        rows: 4,
        cols: 6,
        description: "6×4 Both Layers",
        isTall: true
      },
      "BOX-ALL-144": { rows: 6, cols: 12, description: "Legacy 144" },
      "BOX-ALL-96": { rows: 6, cols: 12, description: "Legacy 96" },
      "BOX-ALL-48": { rows: 4, cols: 6, description: "Legacy 48" },
      "BOX-ALL-24": { rows: 2, cols: 6, description: "Legacy 24" },
      [UNORGANIZED_CASE_MODEL]: { rows: 100, cols: 1, description: "Unorganized list" },
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
  const isUnorganized = case_.model === UNORGANIZED_CASE_MODEL;

  // Get matching compartment IDs
  const matchingCompartmentIds = new Set(matchingComponents.map(comp => comp.compartmentId));

  // Create a grid representation
  const topLayerCompartments = case_.compartments.filter(comp => comp.layer === 'top');
  const bottomLayerCompartments = case_.compartments.filter(comp => comp.layer === 'bottom');

  const renderLayer = (compartments: any[], layerName: string, gridRows: number, gridCols: number) => {
    if (compartments.length === 0) return null;

    // Create grid matrix
    const grid = Array(gridRows).fill(null).map(() => Array(gridCols).fill(null));

    // Fill grid with compartments
    compartments.forEach(comp => {
      if (comp.row <= gridRows && comp.col <= gridCols) {
        grid[comp.row - 1][comp.col - 1] = comp;
      }
    });

    return (
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-gray-600 capitalize">{layerName}</h4>
        <div
          className="grid gap-0.5"
          style={{
            gridTemplateColumns: `0.75rem repeat(${gridCols}, 0.75rem)`,
            gridTemplateRows: `0.75rem repeat(${gridRows}, 0.75rem)`
          }}
        >
          <div aria-hidden="true" />
          {Array.from({ length: gridCols }, (_, colIndex) => (
            <div
              key={`${layerName}-col-${colIndex + 1}`}
              className="flex h-3 w-3 items-center justify-center text-[7px] font-semibold leading-none text-gray-500"
            >
              {colIndex + 1}
            </div>
          ))}
          {grid.map((row, rowIndex) =>
            [
              <div
                key={`${layerName}-row-${rowIndex + 1}`}
                className="flex h-3 w-3 items-center justify-center text-[7px] font-semibold leading-none text-gray-500"
              >
                {getRowLabel(rowIndex + 1)}
              </div>,
              ...row.map((compartment, colIndex) => {
                const isMatching = compartment && matchingCompartmentIds.has(compartment.id);
                const hasComponent = compartment?.component;

                return (
                  <div
                    key={`${rowIndex}-${colIndex}`}
                    className={`
                      w-3 h-3 border rounded-sm relative transition-all duration-300
                      ${isMatching ? 'bg-yellow-300 border-yellow-700 shadow-xl ring-4 ring-yellow-400 ring-opacity-75 scale-110 z-10' :
                        hasComponent ? 'bg-blue-200 border-blue-300' :
                        'bg-gray-50 border-gray-200'}
                    `}
                    style={{
                      boxShadow: isMatching ? '0 0 12px rgba(255, 193, 7, 0.8), inset 0 0 6px rgba(255, 193, 7, 0.6)' : undefined
                    }}
                    title={compartment ? `${formatCompartmentLocation(compartment)}${hasComponent ? ` - ${compartment.component?.name}` : ''}` : ''}
                  >
                    {isMatching && (
                      <>
                        <div className="absolute inset-0 bg-yellow-200 animate-pulse rounded-sm opacity-80"></div>
                        <div className="absolute inset-0 bg-gradient-to-br from-yellow-200 to-yellow-400 rounded-sm opacity-90"></div>
                        <div className="absolute -inset-1 bg-yellow-300 rounded-md opacity-30 animate-ping"></div>
                      </>
                    )}
                  </div>
                );
              }),
            ]
          )}
        </div>
      </div>
    );
  };

  const topLayout = layout.isMixed ? { rows: layout.rows, cols: layout.cols } : layout;
  const bottomLayout = layout.isMixed ? { rows: 6, cols: 12 } : layout;

  const renderUnorganizedMatches = () => {
    const matchingRows = matchingComponents.slice(0, 5).map((component) => {
      const compartment = case_.compartments.find((item) => item.id === component.compartmentId);
      return {
        component,
        location: compartment?.position ?? "List slot",
      };
    });

    return (
      <div className="space-y-2">
        {matchingRows.map(({ component, location }) => (
          <div
            key={component.id}
            className="flex items-center justify-between gap-3 rounded border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm"
          >
            <span className="truncate font-medium text-gray-900">{component.name}</span>
            <span className="shrink-0 font-mono text-xs text-gray-500">{location}</span>
          </div>
        ))}
        {matchingComponents.length > matchingRows.length && (
          <div className="text-xs text-gray-500">
            +{matchingComponents.length - matchingRows.length} more
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-lg border border-gray-200 p-4 hover:border-blue-300 hover:shadow-md transition-all cursor-pointer"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-gray-900">{case_.name}</h3>
          <p className="text-sm text-gray-600">{layout.description}</p>
        </div>
        <Badge variant="secondary" className="bg-yellow-100 text-yellow-800">
          {matchingComponents.length} match{matchingComponents.length !== 1 ? 'es' : ''}
        </Badge>
      </div>

      <div className="space-y-3">
        {isUnorganized ? (
          renderUnorganizedMatches()
        ) : (
          <>
            {renderLayer(topLayerCompartments, 'top', topLayout.rows, topLayout.cols)}
            {bottomLayerCompartments.length > 0 &&
              renderLayer(bottomLayerCompartments, 'bottom', bottomLayout.rows, bottomLayout.cols)
            }
          </>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
        <span>{case_.compartments.filter(c => c.component).length} filled</span>
        <span>{case_.compartments.length} total</span>
      </div>
    </div>
  );
}
