import {
  Material,
  Mesh,
  Object3D,
  Texture,
  type BufferGeometry,
} from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import { mapWithConcurrency, PromiseAssetCache } from "./async-pool";

export const MAX_GLTF_LOAD_CONCURRENCY = 4;

function asError(value: unknown, url?: string) {
  if (value instanceof Error) return value;
  return new Error(url ? `Unable to load ${url}` : "Unable to load 3D model");
}

function loadWith(loader: GLTFLoader, url: string) {
  return new Promise<GLTF>((resolve, reject) => {
    loader.load(url, resolve, undefined, (error) => reject(asError(error, url)));
  });
}

/**
 * One loader and one promise cache are shared across scene instances. A rejected
 * promise is evicted by PromiseAssetCache, so retrying a temporarily unavailable
 * asset is safe.
 */
export const sharedGltfLoader = new GLTFLoader();
export const sharedGltfAssetCache = new PromiseAssetCache<GLTF>((url) =>
  loadWith(sharedGltfLoader, url),
);

export function loadGltfAsset(url: string) {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) return Promise.reject(new Error("A GLB URL is required"));
  return sharedGltfAssetCache.load(normalizedUrl);
}

/**
 * SkeletonUtils preserves skinned-mesh bone bindings. Geometry, material and
 * texture resources remain shared with the cached template and must not be
 * disposed when this clone is removed from a scene.
 */
export function cloneGltfScene<T extends Object3D>(scene: T): T {
  const clone = cloneSkeleton(scene) as T;
  clone.updateMatrixWorld(true);
  return clone;
}

export function instantiateGltfAsset(asset: Pick<GLTF, "scene">) {
  return cloneGltfScene(asset.scene);
}

export interface PrioritizedGltfRequest<TContext = unknown> {
  url: string;
  context: TContext;
  /** Lower numbers load first. Equal priorities retain input order. */
  priority?: number;
}

export type PrioritizedGltfResult<TContext = unknown> =
  | {
      request: PrioritizedGltfRequest<TContext>;
      asset: GLTF;
      error: null;
    }
  | {
      request: PrioritizedGltfRequest<TContext>;
      asset: null;
      error: Error;
    };

export interface PrioritizedGltfLoadOptions<TContext> {
  signal?: AbortSignal;
  concurrency?: number;
  onSettled?: (
    result: PrioritizedGltfResult<TContext>,
    completed: number,
    total: number,
  ) => void;
}

/**
 * Loads requests progressively while guaranteeing that no more than four cache
 * misses are started at once. Callers may use context to associate a result with
 * one or more compartments that share the URL.
 */
export async function loadPrioritizedGltfAssets<TContext>(
  requests: readonly PrioritizedGltfRequest<TContext>[],
  options: PrioritizedGltfLoadOptions<TContext> = {},
) {
  const ordered = requests
    .map((request, index) => ({ request, index }))
    .sort(
      (left, right) =>
        (left.request.priority ?? 0) - (right.request.priority ?? 0) ||
        left.index - right.index,
    );
  const requestedConcurrency = Number.isFinite(options.concurrency)
    ? Math.floor(options.concurrency as number)
    : MAX_GLTF_LOAD_CONCURRENCY;
  const concurrency = Math.max(
    1,
    Math.min(MAX_GLTF_LOAD_CONCURRENCY, requestedConcurrency),
  );
  let completed = 0;

  return mapWithConcurrency(ordered, concurrency, async ({ request }) => {
    let result: PrioritizedGltfResult<TContext>;
    if (options.signal?.aborted) {
      result = {
        request,
        asset: null,
        error: new DOMException("3D model loading was cancelled", "AbortError"),
      };
    } else {
      try {
        const asset = await loadGltfAsset(request.url);
        result = options.signal?.aborted
          ? {
              request,
              asset: null,
              error: new DOMException("3D model loading was cancelled", "AbortError"),
            }
          : { request, asset, error: null };
      } catch (error) {
        result = { request, asset: null, error: asError(error, request.url) };
      }
    }

    completed += 1;
    options.onSettled?.(result, completed, ordered.length);
    return result;
  });
}

export interface DisposeObject3dOptions {
  removeFromParent?: boolean;
  /** Enable only for resources owned by this object, never cached GLTF clones. */
  geometries?: boolean;
  /** Enable only for resources owned by this object, never cached GLTF clones. */
  materials?: boolean;
  /** Requires materials=true and ownership of the referenced textures. */
  textures?: boolean;
}

function materialTextures(material: Material) {
  const textures = new Set<Texture>();
  for (const value of Object.values(material)) {
    if (value instanceof Texture) textures.add(value);
  }

  const uniforms = (material as Material & {
    uniforms?: Record<string, { value?: unknown }>;
  }).uniforms;
  if (uniforms) {
    for (const uniform of Object.values(uniforms)) {
      if (uniform.value instanceof Texture) textures.add(uniform.value);
    }
  }
  return textures;
}

/**
 * Removes an object safely. GPU resources are retained by default because GLTF
 * clones share them with the global cache; opt in only for renderer-owned marker
 * geometry/materials or an asset that is being permanently evicted.
 */
export function disposeObject3d(
  root: Object3D,
  options: DisposeObject3dOptions = {},
) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();

  if (options.geometries || options.materials) {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      if (options.geometries) geometries.add(object.geometry);
      if (!options.materials) return;

      const meshMaterials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of meshMaterials) {
        materials.add(material);
        if (options.textures) {
          materialTextures(material).forEach((texture) => textures.add(texture));
        }
      }
    });
  }

  if (options.removeFromParent !== false) root.removeFromParent();
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

export function disposeOwnedObject3d(root: Object3D) {
  disposeObject3d(root, {
    removeFromParent: true,
    geometries: true,
    materials: true,
    textures: true,
  });
}
