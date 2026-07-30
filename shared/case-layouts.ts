export type CaseLayer = "top" | "bottom";

export interface CaseLayerLayout {
  layer: CaseLayer;
  rows: number;
  cols: number;
}

export interface CaseLayoutDefaults {
  rows: number;
  cols: number;
  hasBottom: boolean;
}

export const UNSORTED_CASE_MODEL = "UNSORTED";
export const UNSORTED_CASE_NAME = "Unsorted Items";
export const UNSORTED_CASE_ROWS = 10;
export const UNSORTED_CASE_COLS = 10;
export const UNORGANIZED_CASE_MODEL = "UNORGANIZED";
export const UNORGANIZED_CASE_ROWS = 100;
export const UNORGANIZED_CASE_COLS = 1;

export const CASE_MODEL_DEFAULTS: Record<string, CaseLayoutDefaults> = {
  [UNSORTED_CASE_MODEL]: {
    rows: UNSORTED_CASE_ROWS,
    cols: UNSORTED_CASE_COLS,
    hasBottom: false,
  },
  [UNORGANIZED_CASE_MODEL]: {
    rows: UNORGANIZED_CASE_ROWS,
    cols: UNORGANIZED_CASE_COLS,
    hasBottom: false,
  },
  "LAYOUT-12x6-BOTH": {
    rows: 6,
    cols: 12,
    hasBottom: true,
  },
  "LAYOUT-6x4-TOP": {
    rows: 4,
    cols: 6,
    hasBottom: true,
  },
  "LAYOUT-6x4-BOTH": {
    rows: 4,
    cols: 6,
    hasBottom: true,
  },
};

export function getCustomCaseModel(rows: number, cols: number, hasBottom: boolean) {
  return `CUSTOM-${cols}x${rows}-${hasBottom ? "BOTH" : "TOP"}`;
}

function parseCustomCaseModel(model: string): CaseLayoutDefaults | undefined {
  const match = model.match(/^CUSTOM-(\d+)x(\d+)-(TOP|BOTH)$/);
  if (!match) return undefined;

  return {
    cols: Number(match[1]),
    rows: Number(match[2]),
    hasBottom: match[3] === "BOTH",
  };
}

export function getCaseDefaults(model: string): CaseLayoutDefaults {
  return CASE_MODEL_DEFAULTS[model] ?? parseCustomCaseModel(model) ?? {
    rows: 6,
    cols: 12,
    hasBottom: false,
  };
}

export function isUnorganizedCaseModel(model: string) {
  return model === UNORGANIZED_CASE_MODEL;
}

export function getCompartmentPosition(case_: { model: string }, row: number, col: number) {
  if (isUnorganizedCaseModel(case_.model)) {
    return `Item ${row}`;
  }

  const rowLetter = String.fromCharCode(64 + row);
  return `${rowLetter}${col}`;
}

export function getCaseLayerLayouts(case_: {
  model: string;
  rows: number;
  cols: number;
  hasBottom?: boolean | null;
}): CaseLayerLayout[] {
  if (case_.model === "LAYOUT-6x4-TOP") {
    return [
      { layer: "top", rows: 4, cols: 6 },
      { layer: "bottom", rows: 6, cols: 12 },
    ];
  }

  const layouts: CaseLayerLayout[] = [
    { layer: "top", rows: case_.rows, cols: case_.cols },
  ];

  if (case_.hasBottom) {
    layouts.push({ layer: "bottom", rows: case_.rows, cols: case_.cols });
  }

  return layouts;
}
