import { z } from "zod";

export const CUSTOM_CASE_LAYOUT_VERSION = 1 as const;
export const CUSTOM_CASE_LAYOUT_UNITS = 10_000 as const;
export const CUSTOM_CASE_LAYOUT_MIN_TRACK = 100;

export type CustomCaseLayerName = "top" | "bottom";

const customCaseTrackSchema = z
  .number()
  .int()
  .min(CUSTOM_CASE_LAYOUT_MIN_TRACK)
  .max(CUSTOM_CASE_LAYOUT_UNITS);

function trackTotal(tracks: readonly number[]) {
  return tracks.reduce((total, track) => total + track, 0);
}

export const customCaseLayerGeometrySchema = z
  .object({
    rowHeights: z.array(customCaseTrackSchema).min(1),
    columnWidthsByRow: z.array(z.array(customCaseTrackSchema).min(1)).min(1),
  })
  .strict()
  .superRefine((layer, context) => {
    if (trackTotal(layer.rowHeights) !== CUSTOM_CASE_LAYOUT_UNITS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Row heights must total ${CUSTOM_CASE_LAYOUT_UNITS}`,
        path: ["rowHeights"],
      });
    }

    layer.columnWidthsByRow.forEach((widths, rowIndex) => {
      if (trackTotal(widths) !== CUSTOM_CASE_LAYOUT_UNITS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Column widths must total ${CUSTOM_CASE_LAYOUT_UNITS}`,
          path: ["columnWidthsByRow", rowIndex],
        });
      }
    });
  });

export const customCaseLayoutGeometrySchema = z
  .object({
    version: z.literal(CUSTOM_CASE_LAYOUT_VERSION),
    units: z.literal(CUSTOM_CASE_LAYOUT_UNITS),
    layers: z
      .object({
        top: customCaseLayerGeometrySchema,
        bottom: customCaseLayerGeometrySchema.optional(),
      })
      .strict(),
  })
  .strict();

export type CustomCaseLayerGeometry = z.infer<typeof customCaseLayerGeometrySchema>;
export type CustomCaseLayoutGeometry = z.infer<typeof customCaseLayoutGeometrySchema>;
/** Short schema-facing alias used by the persisted Case model. */
export type CustomCaseGeometry = CustomCaseLayoutGeometry;

export interface CustomCaseLayoutDimensions {
  rows: number;
  cols: number;
  hasBottom: boolean;
}

function assertCount(name: "rows" | "cols", count: number) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }

  if (count * CUSTOM_CASE_LAYOUT_MIN_TRACK > CUSTOM_CASE_LAYOUT_UNITS) {
    throw new RangeError(`${name} exceeds the supported custom layout size`);
  }
}

function validateLayerDimensions(
  layer: CustomCaseLayerGeometry,
  layerName: CustomCaseLayerName,
  dimensions: CustomCaseLayoutDimensions,
  context: z.RefinementCtx,
) {
  const layerPath = ["layers", layerName] as const;

  if (layer.rowHeights.length !== dimensions.rows) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${layerName} must contain ${dimensions.rows} row heights`,
      path: [...layerPath, "rowHeights"],
    });
  }

  if (layer.columnWidthsByRow.length !== dimensions.rows) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${layerName} must contain ${dimensions.rows} rows of column widths`,
      path: [...layerPath, "columnWidthsByRow"],
    });
  }

  layer.columnWidthsByRow.forEach((widths, rowIndex) => {
    if (widths.length !== dimensions.cols) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${layerName} row ${rowIndex + 1} must contain ${dimensions.cols} column widths`,
        path: [...layerPath, "columnWidthsByRow", rowIndex],
      });
    }
  });
}

/** Returns a strict schema tied to a case's logical dimensions and layer count. */
export function customCaseLayoutSchemaForCase(dimensions: CustomCaseLayoutDimensions) {
  assertCount("rows", dimensions.rows);
  assertCount("cols", dimensions.cols);

  return customCaseLayoutGeometrySchema.superRefine((layout, context) => {
    validateLayerDimensions(layout.layers.top, "top", dimensions, context);

    if (dimensions.hasBottom) {
      if (!layout.layers.bottom) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A bottom-layer layout is required for this case",
          path: ["layers", "bottom"],
        });
      } else {
        validateLayerDimensions(layout.layers.bottom, "bottom", dimensions, context);
      }
    } else if (layout.layers.bottom) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A top-only case cannot contain a bottom-layer layout",
        path: ["layers", "bottom"],
      });
    }
  });
}

export function safeParseCustomCaseLayout(
  value: unknown,
  dimensions: CustomCaseLayoutDimensions,
) {
  return customCaseLayoutSchemaForCase(dimensions).safeParse(value);
}

export function parseCustomCaseLayout(
  value: unknown,
  dimensions: CustomCaseLayoutDimensions,
) {
  return customCaseLayoutSchemaForCase(dimensions).parse(value);
}

function distributeUniformly(count: number) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError("Track count must be a positive integer");
  }

  const base = Math.floor(CUSTOM_CASE_LAYOUT_UNITS / count);
  const remainder = CUSTOM_CASE_LAYOUT_UNITS - base * count;

  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function createUniformCustomCaseLayer(
  rows: number,
  cols: number,
): CustomCaseLayerGeometry {
  assertCount("rows", rows);
  assertCount("cols", cols);

  const uniformWidths = distributeUniformly(cols);

  return {
    rowHeights: distributeUniformly(rows),
    columnWidthsByRow: Array.from({ length: rows }, () => [...uniformWidths]),
  };
}

export function cloneCustomCaseLayer(
  layer: CustomCaseLayerGeometry,
): CustomCaseLayerGeometry {
  return {
    rowHeights: [...layer.rowHeights],
    columnWidthsByRow: layer.columnWidthsByRow.map((widths) => [...widths]),
  };
}

export function createUniformCustomCaseLayout(
  rows: number,
  cols: number,
  hasBottom: boolean,
): CustomCaseLayoutGeometry {
  const top = createUniformCustomCaseLayer(rows, cols);

  return {
    version: CUSTOM_CASE_LAYOUT_VERSION,
    units: CUSTOM_CASE_LAYOUT_UNITS,
    layers: {
      top,
      ...(hasBottom ? { bottom: cloneCustomCaseLayer(top) } : {}),
    },
  };
}

export function cloneCustomCaseLayout(
  layout: CustomCaseLayoutGeometry,
): CustomCaseLayoutGeometry {
  return {
    version: CUSTOM_CASE_LAYOUT_VERSION,
    units: CUSTOM_CASE_LAYOUT_UNITS,
    layers: {
      top: cloneCustomCaseLayer(layout.layers.top),
      ...(layout.layers.bottom
        ? { bottom: cloneCustomCaseLayer(layout.layers.bottom) }
        : {}),
    },
  };
}

export function replaceCustomCaseLayer(
  layout: CustomCaseLayoutGeometry,
  layerName: CustomCaseLayerName,
  layer: CustomCaseLayerGeometry,
): CustomCaseLayoutGeometry {
  return {
    ...layout,
    layers: {
      ...layout.layers,
      [layerName]: cloneCustomCaseLayer(layer),
    },
  };
}

/** Divider index is one-based: 1 is the divider after the first track. */
export function getCustomCaseTrackBoundary(
  tracks: readonly number[],
  dividerIndex: number,
) {
  if (!Number.isInteger(dividerIndex) || dividerIndex < 1 || dividerIndex >= tracks.length) {
    throw new RangeError("Divider index is outside the track list");
  }

  return trackTotal(tracks.slice(0, dividerIndex));
}

/** Moves one divider while preserving the adjacent pair's combined size. */
export function resizeAdjacentCustomCaseTracks(
  tracks: readonly number[],
  dividerIndex: number,
  requestedBoundary: number,
  minimumTrack = CUSTOM_CASE_LAYOUT_MIN_TRACK,
) {
  if (!Number.isInteger(dividerIndex) || dividerIndex < 1 || dividerIndex >= tracks.length) {
    throw new RangeError("Divider index is outside the track list");
  }
  if (!Number.isFinite(requestedBoundary)) {
    throw new RangeError("Requested boundary must be finite");
  }
  if (!Number.isInteger(minimumTrack) || minimumTrack < 1) {
    throw new RangeError("Minimum track size must be a positive integer");
  }

  const leftIndex = dividerIndex - 1;
  const pairStart = trackTotal(tracks.slice(0, leftIndex));
  const pairEnd = pairStart + tracks[leftIndex] + tracks[dividerIndex];
  const minimumBoundary = pairStart + minimumTrack;
  const maximumBoundary = pairEnd - minimumTrack;

  if (minimumBoundary > maximumBoundary) {
    throw new RangeError("Adjacent tracks are smaller than the requested minimum size");
  }

  const boundary = Math.min(
    maximumBoundary,
    Math.max(minimumBoundary, Math.round(requestedBoundary)),
  );
  const resized = [...tracks];
  resized[leftIndex] = boundary - pairStart;
  resized[dividerIndex] = pairEnd - boundary;
  return resized;
}

export function resizeCustomCaseColumnBoundary(
  layer: CustomCaseLayerGeometry,
  rowIndex: number,
  dividerIndex: number,
  requestedBoundary: number,
  minimumTrack = CUSTOM_CASE_LAYOUT_MIN_TRACK,
): CustomCaseLayerGeometry {
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= layer.columnWidthsByRow.length) {
    throw new RangeError("Row index is outside the layer");
  }

  return {
    rowHeights: [...layer.rowHeights],
    columnWidthsByRow: layer.columnWidthsByRow.map((widths, index) =>
      index === rowIndex
        ? resizeAdjacentCustomCaseTracks(
            widths,
            dividerIndex,
            requestedBoundary,
            minimumTrack,
          )
        : [...widths],
    ),
  };
}

export function resizeCustomCaseRowBoundary(
  layer: CustomCaseLayerGeometry,
  dividerIndex: number,
  requestedBoundary: number,
  minimumTrack = CUSTOM_CASE_LAYOUT_MIN_TRACK,
): CustomCaseLayerGeometry {
  return {
    rowHeights: resizeAdjacentCustomCaseTracks(
      layer.rowHeights,
      dividerIndex,
      requestedBoundary,
      minimumTrack,
    ),
    columnWidthsByRow: layer.columnWidthsByRow.map((widths) => [...widths]),
  };
}
