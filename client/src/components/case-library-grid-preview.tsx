import {
  CUSTOM_CASE_LAYOUT_UNITS,
  createUniformCustomCaseLayer,
  safeParseCustomCaseLayout,
  type CustomCaseLayerGeometry,
  type CustomCaseLayerName,
} from "@shared/custom-case-layout";
import {
  getCaseLayerLayouts,
  isUnorganizedCaseModel,
} from "@shared/case-layouts";
import type { Case, CaseWithCompartments } from "@shared/schema";

interface CaseLibraryGridPreviewProps {
  case_: Case;
  detail?: CaseWithCompartments;
  isLoading?: boolean;
}

type PopulatedCompartment = CaseWithCompartments["compartments"][number];

interface PreviewLayer {
  key: CustomCaseLayerName;
  label: string;
  rows: number;
  cols: number;
  geometry: CustomCaseLayerGeometry;
  getCompartment: (rowIndex: number, colIndex: number) => PopulatedCompartment | undefined;
}

function getBinState(compartment: PopulatedCompartment | undefined) {
  const component = compartment?.component;
  if (!component) return "empty";

  const isLow =
    component.quantity === 0 ||
    (component.minQuantity !== null && component.quantity <= component.minQuantity);
  return isLow ? "low" : "stocked";
}

function getCustomGeometry(case_: Case) {
  if (!case_.model.startsWith("CUSTOM-")) return null;

  const parsed = safeParseCustomCaseLayout(case_.layoutGeometry, {
    rows: case_.rows,
    cols: case_.cols,
    hasBottom: Boolean(case_.hasBottom),
  });
  return parsed.success ? parsed.data : null;
}

function buildPreviewLayers(
  case_: Case,
  detail: CaseWithCompartments | undefined,
): PreviewLayer[] {
  const customGeometry = getCustomGeometry(case_);
  const layerLayouts = getCaseLayerLayouts(case_);

  return layerLayouts.map((layout) => {
    const compartments = (detail?.compartments || [])
      .filter((compartment) => compartment.layer === layout.layer)
      .sort((left, right) => left.row - right.row || left.col - right.col);

    if (isUnorganizedCaseModel(case_.model)) {
      const capacity = Math.max(case_.rows * case_.cols, compartments.length, 1);
      const cols = Math.ceil(Math.sqrt(capacity));
      const rows = Math.ceil(capacity / cols);

      return {
        key: layout.layer,
        label: "List",
        rows,
        cols,
        geometry: createUniformCustomCaseLayer(rows, cols),
        getCompartment: (rowIndex, colIndex) =>
          compartments[rowIndex * cols + colIndex],
      };
    }

    const byCoordinate = new Map(
      compartments.map((compartment) => [
        `${compartment.row}:${compartment.col}`,
        compartment,
      ]),
    );
    const customLayer = customGeometry?.layers[layout.layer];

    return {
      key: layout.layer,
      label: layout.layer === "top" ? "Top" : "Bottom",
      rows: layout.rows,
      cols: layout.cols,
      geometry:
        customLayer || createUniformCustomCaseLayer(layout.rows, layout.cols),
      getCompartment: (rowIndex, colIndex) =>
        byCoordinate.get(`${rowIndex + 1}:${colIndex + 1}`),
    };
  });
}

function LayerPreview({ layer }: { layer: PreviewLayer }) {
  const viewBoxWidth = Math.max(layer.cols, 1) * 1_000;
  const viewBoxHeight = Math.max(layer.rows, 1) * 1_000;
  const density = Math.max(layer.rows, layer.cols);
  const gap = Math.max(14, Math.min(74, 118 - density * 4));
  let yUnits = 0;

  const bins = layer.geometry.rowHeights.flatMap((heightUnits, rowIndex) => {
    const y = (yUnits / CUSTOM_CASE_LAYOUT_UNITS) * viewBoxHeight;
    const height = (heightUnits / CUSTOM_CASE_LAYOUT_UNITS) * viewBoxHeight;
    yUnits += heightUnits;
    let xUnits = 0;

    return layer.geometry.columnWidthsByRow[rowIndex].map((widthUnits, colIndex) => {
      const x = (xUnits / CUSTOM_CASE_LAYOUT_UNITS) * viewBoxWidth;
      const width = (widthUnits / CUSTOM_CASE_LAYOUT_UNITS) * viewBoxWidth;
      xUnits += widthUnits;
      const state = getBinState(layer.getCompartment(rowIndex, colIndex));
      const inset = Math.min(gap, width * 0.22, height * 0.22);

      return (
        <rect
          key={`${rowIndex}-${colIndex}`}
          className={`case-library-grid-bin case-library-grid-bin--${state}`}
          x={x + inset / 2}
          y={y + inset / 2}
          width={Math.max(1, width - inset)}
          height={Math.max(1, height - inset)}
          rx={Math.max(5, Math.min(42, Math.min(width, height) * 0.1))}
          vectorEffect="non-scaling-stroke"
        />
      );
    });
  });

  return (
    <div className="case-library-grid-preview-layer">
      <span className="case-library-grid-preview-layer-label">{layer.label}</span>
      <div className="case-library-grid-preview-canvas">
        <svg
          viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
          preserveAspectRatio="xMidYMid meet"
          focusable="false"
          aria-hidden="true"
        >
          {bins}
        </svg>
      </div>
    </div>
  );
}

export default function CaseLibraryGridPreview({
  case_,
  detail,
  isLoading = false,
}: CaseLibraryGridPreviewProps) {
  const layers = buildPreviewLayers(case_, detail);

  return (
    <div
      className={`case-library-grid-preview ${layers.length > 1 ? "case-library-grid-preview--split" : ""} ${isLoading ? "case-library-grid-preview--loading" : ""}`}
      aria-hidden="true"
    >
      <div className="case-library-grid-preview-layers">
        {layers.map((layer) => (
          <LayerPreview key={layer.key} layer={layer} />
        ))}
      </div>
      <div className="case-library-grid-preview-legend">
        <span>
          <i className="case-library-grid-preview-key case-library-grid-preview-key--stocked" />
          Stocked
        </span>
        <span>
          <i className="case-library-grid-preview-key case-library-grid-preview-key--low" />
          Low
        </span>
      </div>
    </div>
  );
}
