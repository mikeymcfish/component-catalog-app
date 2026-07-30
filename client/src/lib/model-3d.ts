export type Model3dSource = "kicad" | "upload";

export interface ModelAsset {
  assetId: string;
  url: string;
  name: string;
  source: Model3dSource;
}

export interface KicadModelResult {
  id: string;
  name: string;
  extension: string;
  library: string;
  relativePath: string;
}

export type ModelSelection =
  | { kind: "none" }
  | { kind: "existing"; asset: ModelAsset }
  | { kind: "upload"; file: File }
  | { kind: "kicad"; model: KicadModelResult };

export function getModelAssetId(url: string | null | undefined) {
  return url?.match(/^\/uploads\/models\/([a-f0-9]{64})\.glb$/)?.[1] || null;
}

export function getSelectionName(selection: ModelSelection) {
  if (selection.kind === "existing") return selection.asset.name;
  if (selection.kind === "upload") return selection.file.name;
  if (selection.kind === "kicad") return selection.model.name;
  return null;
}
