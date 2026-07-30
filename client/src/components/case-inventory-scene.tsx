import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  InstancedMesh,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  disposeObject3d,
  instantiateGltfAsset,
  loadGltfAsset,
  loadPrioritizedGltfAssets,
} from "@/lib/case-3d-scene/assets";
import { createCompartmentNumberLabels } from "@/lib/case-3d-scene/compartment-labels";
import {
  cloneRepresentativeCaseMaterial,
  layoutOpenCaseAssembly,
} from "@/lib/case-3d-scene/assembly";
import { caseSceneModelUrlKey } from "@/lib/case-3d-scene/model-set";
import type {
  CaseInventorySceneHandle,
  CaseInventorySceneProps,
  CaseSceneLayer,
} from "@/lib/case-3d-scene/types";
import {
  createComponentPlacementMatrix,
  applyCaseModelUnitScale,
  componentModelRotationQuaternion,
  computeComponentPlacement,
  mapCaseCompartmentAnchors,
  type ComponentScalePolicy,
  type CompartmentAnchor,
} from "@/lib/case-3d-scene/geometry";

interface InteractiveTarget {
  object: Object3D;
  compartmentId: number;
  componentId?: number;
  instanceComponentIds?: number[];
}

interface SceneRuntime {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  controls: OrbitControls;
  caseGroup: Group;
  hingeGroup: Group;
  inventoryGroup: Group;
  labelGroup: Group;
  markerGroup: Group;
  calibrationGroup: Group;
  hitGroup: Group;
  anchors: Map<number, CompartmentAnchor>;
  interactive: InteractiveTarget[];
  casePickMeshes: Map<CaseSceneLayer, Object3D[]>;
  render: () => void;
  resetCamera: () => void;
  fitCamera: (bounds?: Box3) => void;
}

interface ComponentOccurrence {
  compartmentId: number;
  componentId: number;
  componentName: string;
  modelUrl: string;
  anchor: CompartmentAnchor;
  selected: boolean;
  priority: number;
  rotation: Quaternion;
}

interface LoadedCaseHalf {
  layer: CaseSceneLayer;
  root: Object3D;
  pivot: Group;
  content: Group;
}

const DEFAULT_CAMERA_DIRECTION = new Vector3(1.1, -1.25, 0.9).normalize();
const FLOAT_GAP_METERS = 0.003;

function normalizeVisibleIds(value: CaseInventorySceneProps["visibleCompartmentIds"]) {
  if (!value) return new Set<number>();
  return value instanceof Set ? new Set(value) : new Set(Array.from(value));
}

function normalizePriorityIds(value: CaseInventorySceneProps["priorityCompartmentIds"]) {
  if (!value) return new Set<number>();
  return value instanceof Set ? new Set(value) : new Set(Array.from(value));
}

function disposeMaterial(material: Material | Material[]) {
  if (Array.isArray(material)) {
    for (const item of material) item.dispose();
  } else {
    material.dispose();
  }
}

function clearOwnedGroup(group: Group) {
  for (const child of [...group.children]) {
    child.removeFromParent();
    child.traverse(object => {
      if (!(object instanceof Mesh)) return;
      if (object instanceof InstancedMesh) object.dispose();
      object.geometry.dispose();
      disposeMaterial(object.material);
    });
  }
}

function clearCachedCloneGroup(group: Group) {
  for (const child of [...group.children]) {
    const clonedSkeletons = new Set<Skeleton>();
    // Instanced meshes own their instanceMatrix/instanceColor GPU buffers even
    // when their geometry and material come from the shared GLTF cache.
    child.traverse(object => {
      if (object instanceof InstancedMesh) object.dispose();
      if (object instanceof SkinnedMesh) clonedSkeletons.add(object.skeleton);
    });
    clonedSkeletons.forEach(skeleton => skeleton.dispose());
    disposeObject3d(child, { removeFromParent: true });
  }
}

function fitCameraToBounds(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  bounds: Box3,
  render: () => void,
) {
  if (bounds.isEmpty()) return;
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const radius = Math.max(size.length() * 0.55, 0.025);
  const verticalHalfFov = (camera.fov * Math.PI) / 360;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
  const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
  const distance = Math.max(radius / Math.tan(limitingHalfFov), radius * 2.2);
  camera.position.copy(center).addScaledVector(DEFAULT_CAMERA_DIRECTION, distance);
  camera.near = Math.max(distance / 1000, 0.0001);
  camera.far = Math.max(distance * 20, 10);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  render();
}

function focusRuntimeCompartment(runtime: SceneRuntime, compartmentId: number) {
  const anchor = runtime.anchors.get(compartmentId);
  if (!anchor) return false;
  const size = anchor.bounds.getSize(new Vector3()).length();
  const distance = Math.max(size * 4, 0.045);
  runtime.controls.target.copy(anchor.center);
  runtime.camera.position
    .copy(anchor.center)
    .addScaledVector(DEFAULT_CAMERA_DIRECTION, distance);
  runtime.controls.update();
  runtime.render();
  return true;
}

function createLocatorMarker(anchor: CompartmentAnchor) {
  const group = new Group();
  const normal = anchor.normal.clone().normalize();
  const markerBase = anchor.center.clone().addScaledVector(normal, FLOAT_GAP_METERS);
  const scale = Math.max(anchor.bounds.getSize(new Vector3()).length() * 0.12, 0.0025);
  const color = new Color("#818cf8");
  const material = new MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.08 });
  const sphere = new Mesh(new SphereGeometry(scale * 0.45, 14, 10), material.clone());
  const cone = new Mesh(new ConeGeometry(scale * 0.34, scale * 1.15, 14), material);
  const up = new Vector3(0, 1, 0);
  const orientation = new Quaternion().setFromUnitVectors(up, normal);
  cone.quaternion.copy(orientation);
  cone.position.copy(markerBase).addScaledVector(normal, scale * 0.75);
  sphere.position.copy(markerBase).addScaledVector(normal, scale * 1.45);
  group.add(cone, sphere);
  return group;
}

function createCompartmentHitTarget(anchor: CompartmentAnchor) {
  const size = anchor.bounds.getSize(new Vector3());
  const safeSize = new Vector3(
    Math.max(size.x, 0.004),
    Math.max(size.y, 0.004),
    Math.max(size.z, 0.004),
  );
  const material = new MeshStandardMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const hit = new Mesh(new BoxGeometry(safeSize.x, safeSize.y, safeSize.z), material);
  hit.position.copy(anchor.bounds.getCenter(new Vector3()));
  hit.renderOrder = -1;
  return hit;
}

function addCalibrationMarker(
  group: Group,
  point: Vector3,
  mode: NonNullable<CaseInventorySceneProps["calibrationPickMode"]>,
  caseBounds: Box3,
) {
  const caseSize = caseBounds.getSize(new Vector3()).length();
  const radius = Math.max(caseSize * 0.008, 0.0012);
  const colors = {
    origin: "#22c55e",
    columnEnd: "#38bdf8",
    rowEnd: "#f59e0b",
  } as const;
  const marker = new Mesh(
    new SphereGeometry(radius, 18, 12),
    new MeshStandardMaterial({
      color: colors[mode],
      emissive: colors[mode],
      emissiveIntensity: 0.35,
      roughness: 0.3,
    }),
  );
  marker.position.copy(point);
  marker.renderOrder = 5;
  group.add(marker);
}

function renderCalibrationMarkers(
  runtime: SceneRuntime,
  caseRoot: Object3D,
  picks: ReadonlyMap<
    NonNullable<CaseInventorySceneProps["calibrationPickMode"]>,
    Vector3
  >,
) {
  clearOwnedGroup(runtime.calibrationGroup);
  caseRoot.updateMatrixWorld(true);
  const caseBounds = new Box3().setFromObject(runtime.caseGroup);
  picks.forEach((localPoint, mode) => {
    addCalibrationMarker(
      runtime.calibrationGroup,
      caseRoot.localToWorld(localPoint.clone()),
      mode,
      caseBounds,
    );
  });
}

function hasUnsupportedInstancing(root: Object3D) {
  let unsupported = false;
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    if (object instanceof InstancedMesh) {
      unsupported = true;
      return;
    }
    const mesh = object as Mesh & { isSkinnedMesh?: boolean };
    if (mesh.isSkinnedMesh || mesh.morphTargetInfluences) unsupported = true;
  });
  return unsupported;
}

function addInstancedOccurrences(
  template: Object3D,
  occurrences: ComponentOccurrence[],
  parent: Group,
  interactive: InteractiveTarget[],
  scalePolicy: ComponentScalePolicy,
) {
  if (hasUnsupportedInstancing(template)) return null;
  template.updateMatrixWorld(true);

  const placements = occurrences.map(occurrence => {
    const placement = computeComponentPlacement(
      template,
      occurrence.anchor,
      FLOAT_GAP_METERS,
      scalePolicy,
      occurrence.rotation,
    );
    return {
      occurrence,
      placement,
      matrix: createComponentPlacementMatrix(placement),
    };
  });
  const batches: InstancedMesh[] = [];

  template.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const batch = new InstancedMesh(object.geometry, object.material, placements.length);
    batch.name = `${object.name || "component"}-instances`;
    batch.castShadow = object.castShadow;
    batch.receiveShadow = object.receiveShadow;
    const componentIds: number[] = [];

    placements.forEach(({ occurrence, matrix }, index) => {
      batch.setMatrixAt(index, matrix.clone().multiply(object.matrixWorld));
      batch.setColorAt(
        index,
        new Color(occurrence.selected ? "#c7d2fe" : "#ffffff"),
      );
      componentIds[index] = occurrence.componentId;
    });
    batch.instanceMatrix.needsUpdate = true;
    if (batch.instanceColor) batch.instanceColor.needsUpdate = true;
    parent.add(batch);
    interactive.push({
      object: batch,
      compartmentId: occurrences[0].compartmentId,
      instanceComponentIds: componentIds,
    });
    batches.push(batch);
  });

  return batches.length > 0 ? placements : null;
}

function findInteractiveTarget(
  object: Object3D,
  targets: InteractiveTarget[],
) {
  let current: Object3D | null = object;
  while (current) {
    const target = targets.find(candidate => candidate.object === current);
    if (target) return target;
    current = current.parent;
  }
  return null;
}

const CaseInventoryScene = forwardRef<CaseInventorySceneHandle, CaseInventorySceneProps>(
  function CaseInventoryScene(
    {
      case_,
      caseModels,
      calibrationLayer,
      visibleCompartmentIds,
      priorityCompartmentIds,
      selectedCompartmentId = null,
      componentScaleMode = "display",
      componentDisplaySizeMeters = 0.01,
      showCaseModel = true,
      showCompartmentNumbers = false,
      calibrationActive = false,
      calibrationPickMode = null,
      onCalibrationPick,
      onSelectCompartment,
      onOpenComponent,
      onMappingStatus,
      onFailure,
      className,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasHostRef = useRef<HTMLDivElement>(null);
    const runtimeRef = useRef<SceneRuntime | null>(null);
    const caseRootsRef = useRef(new Map<CaseSceneLayer, Object3D>());
    const calibrationPicksRef = useRef(new Map<
      NonNullable<CaseInventorySceneProps["calibrationPickMode"]>,
      Vector3
    >());
    const calibrationPickModeRef = useRef(calibrationPickMode);
    const calibrationLayerRef = useRef(calibrationLayer);
    const previousCalibrationPickModeRef = useRef(calibrationPickMode);
    const pointerStartRef = useRef<Vector2 | null>(null);
    const callbacksRef = useRef({
      onCalibrationPick,
      onSelectCompartment,
      onOpenComponent,
      onMappingStatus,
      onFailure,
    });
    const [anchorRevision, setAnchorRevision] = useState(0);
    const [statusMessage, setStatusMessage] = useState("Preparing 3D view…");
    const [warnings, setWarnings] = useState<string[]>([]);

    callbacksRef.current = {
      onCalibrationPick,
      onSelectCompartment,
      onOpenComponent,
      onMappingStatus,
      onFailure,
    };
    calibrationPickModeRef.current = calibrationPickMode;
    calibrationLayerRef.current = calibrationLayer;
    const caseModelUrlsKey = useMemo(
      () => caseSceneModelUrlKey(caseModels),
      [caseModels],
    );

    useEffect(() => {
      if (
        calibrationPickMode === "origin" &&
        previousCalibrationPickModeRef.current !== "origin" &&
        runtimeRef.current
      ) {
        calibrationPicksRef.current.clear();
        clearOwnedGroup(runtimeRef.current.calibrationGroup);
        runtimeRef.current.render();
      }
      previousCalibrationPickModeRef.current = calibrationPickMode;
    }, [calibrationPickMode]);

    useEffect(() => {
      if (!calibrationActive) {
        calibrationPicksRef.current.clear();
      }
      if (!calibrationActive && runtimeRef.current) {
        clearOwnedGroup(runtimeRef.current.calibrationGroup);
        runtimeRef.current.render();
      }
    }, [calibrationActive]);

    useEffect(() => {
      calibrationPicksRef.current.clear();
      if (runtimeRef.current) {
        clearOwnedGroup(runtimeRef.current.calibrationGroup);
        runtimeRef.current.render();
      }
    }, [calibrationLayer, case_.id, caseModelUrlsKey]);

    const visibleIds = useMemo(
      () => normalizeVisibleIds(visibleCompartmentIds),
      [visibleCompartmentIds],
    );
    const visibleKey = useMemo(
      () => Array.from(visibleIds).sort((left, right) => left - right).join(","),
      [visibleIds],
    );
    const priorityIds = useMemo(
      () => normalizePriorityIds(priorityCompartmentIds),
      [priorityCompartmentIds],
    );
    const priorityKey = useMemo(
      () => Array.from(priorityIds).sort((left, right) => left - right).join(","),
      [priorityIds],
    );

    useImperativeHandle(ref, () => ({
      resetCamera() {
        runtimeRef.current?.resetCamera();
      },
      focusCompartment(compartmentId) {
        const runtime = runtimeRef.current;
        return runtime ? focusRuntimeCompartment(runtime, compartmentId) : false;
      },
      async enterFullscreen() {
        if (containerRef.current?.requestFullscreen) {
          await containerRef.current.requestFullscreen();
        }
      },
    }), []);

    useEffect(() => {
      const container = containerRef.current;
      const canvasHost = canvasHostRef.current;
      if (!container || !canvasHost) return;

      let renderer: WebGLRenderer;
      try {
        renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("WebGL is unavailable.");
        setStatusMessage("3D rendering is unavailable.");
        callbacksRef.current.onFailure?.(failure);
        return;
      }

      const scene = new Scene();
      scene.background = new Color("#0f172a");
      const camera = new PerspectiveCamera(38, 1, 0.0001, 100);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.screenSpacePanning = true;
      controls.minDistance = 0.005;
      // Unknown case assets may use millimetres (or another large authored
      // unit) until calibrated, so camera fitting must not be artificially
      // clamped before the user can pick calibration points.
      controls.maxDistance = Infinity;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.shadowMap.enabled = true;
      renderer.domElement.className = "block h-full w-full touch-none";
      renderer.domElement.setAttribute("aria-hidden", "true");
      canvasHost.append(renderer.domElement);

      const caseGroup = new Group();
      const hingeGroup = new Group();
      hingeGroup.name = "case-assembly-hinge";
      const inventoryGroup = new Group();
      const labelGroup = new Group();
      const markerGroup = new Group();
      const calibrationGroup = new Group();
      const hitGroup = new Group();
      hitGroup.name = "compartment-hit-targets";
      scene.add(
        caseGroup,
        hingeGroup,
        inventoryGroup,
        labelGroup,
        markerGroup,
        calibrationGroup,
        hitGroup,
      );
      scene.add(new AmbientLight("#dbeafe", 1.65));
      const keyLight = new DirectionalLight("#ffffff", 3.2);
      keyLight.position.set(2, -2.5, 4);
      keyLight.castShadow = true;
      scene.add(keyLight);
      const fillLight = new DirectionalLight("#818cf8", 1.4);
      fillLight.position.set(-3, 2, 2);
      scene.add(fillLight);

      let frame = 0;
      const render = () => {
        if (frame) return;
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          renderer.render(scene, camera);
        });
      };
      const fitCamera = (bounds?: Box3) => {
        const fittedBounds = bounds ?? new Box3().setFromObject(caseGroup);
        if (!bounds && hingeGroup.children.length > 0) {
          fittedBounds.union(new Box3().setFromObject(hingeGroup));
        }
        fitCameraToBounds(camera, controls, fittedBounds, render);
      };
      const resetCamera = () => fitCamera();
      const runtime: SceneRuntime = {
        scene,
        camera,
        renderer,
        controls,
        caseGroup,
        hingeGroup,
        inventoryGroup,
        labelGroup,
        markerGroup,
        calibrationGroup,
        hitGroup,
        anchors: new Map(),
        interactive: [],
        casePickMeshes: new Map(),
        render,
        resetCamera,
        fitCamera,
      };
      runtimeRef.current = runtime;

      const resize = () => {
        const width = Math.max(container.clientWidth, 1);
        const height = Math.max(container.clientHeight, 1);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        render();
      };
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);
      controls.addEventListener("change", render);
      resize();

      const raycaster = new Raycaster();
      const pointer = new Vector2();
      const pointerPosition = (event: PointerEvent) => {
        const bounds = renderer.domElement.getBoundingClientRect();
        pointer.set(
          ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
          -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
        );
        return pointer;
      };
      const handlePointerDown = (event: PointerEvent) => {
        pointerStartRef.current = new Vector2(event.clientX, event.clientY);
      };
      const handleContextLost = (event: Event) => {
        event.preventDefault();
        callbacksRef.current.onFailure?.(
          new Error("The browser lost the WebGL rendering context."),
        );
      };
      const handlePointerUp = (event: PointerEvent) => {
        const start = pointerStartRef.current;
        pointerStartRef.current = null;
        if (!start || start.distanceTo(new Vector2(event.clientX, event.clientY)) > 5) return;
        raycaster.setFromCamera(pointerPosition(event), camera);

        const activeCalibrationPickMode = calibrationPickModeRef.current;
        const activeCalibrationLayer = calibrationLayerRef.current;
        const calibrationRoot = caseRootsRef.current.get(activeCalibrationLayer);
        if (activeCalibrationPickMode && calibrationRoot) {
          const hit = raycaster.intersectObjects(
            runtime.casePickMeshes.get(activeCalibrationLayer) ?? [],
            true,
          )[0];
          if (!hit) return;
          const localPoint = calibrationRoot.worldToLocal(hit.point.clone());
          calibrationPicksRef.current.set(activeCalibrationPickMode, localPoint.clone());
          renderCalibrationMarkers(
            runtime,
            calibrationRoot,
            calibrationPicksRef.current,
          );
          runtime.render();
          callbacksRef.current.onCalibrationPick?.({
            mode: activeCalibrationPickMode,
            point: [localPoint.x, localPoint.y, localPoint.z],
          });
          return;
        }

        const intersections = raycaster.intersectObjects(
          runtime.interactive.map(target => target.object),
          true,
        );
        for (const intersection of intersections) {
          const target = findInteractiveTarget(intersection.object, runtime.interactive);
          if (!target) continue;
          const componentId = target.instanceComponentIds && intersection.instanceId !== undefined
            ? target.instanceComponentIds[intersection.instanceId]
            : target.componentId;
          if (componentId) {
            callbacksRef.current.onOpenComponent?.(componentId);
          } else {
            callbacksRef.current.onSelectCompartment?.(target.compartmentId);
          }
          return;
        }
        callbacksRef.current.onSelectCompartment?.(null);
      };
      renderer.domElement.addEventListener("pointerdown", handlePointerDown);
      renderer.domElement.addEventListener("pointerup", handlePointerUp);
      renderer.domElement.addEventListener("webglcontextlost", handleContextLost);

      return () => {
        resizeObserver.disconnect();
        controls.removeEventListener("change", render);
        controls.dispose();
        renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
        renderer.domElement.removeEventListener("pointerup", handlePointerUp);
        renderer.domElement.removeEventListener("webglcontextlost", handleContextLost);
        if (frame) window.cancelAnimationFrame(frame);
        clearCachedCloneGroup(caseGroup);
        clearOwnedGroup(hingeGroup);
        clearCachedCloneGroup(inventoryGroup);
        clearOwnedGroup(labelGroup);
        clearOwnedGroup(markerGroup);
        clearOwnedGroup(calibrationGroup);
        clearOwnedGroup(hitGroup);
        renderer.dispose();
        renderer.domElement.remove();
        runtimeRef.current = null;
        caseRootsRef.current.clear();
      };
    }, []);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime || caseModels.length === 0) return;
      const abortController = new AbortController();
      let active = true;
      setStatusMessage(
        caseModels.length === 1 ? "Loading case model…" : "Loading case assembly…",
      );
      setWarnings([]);
      runtime.anchors.clear();
      runtime.interactive = [];
      runtime.casePickMeshes = new Map();
      clearCachedCloneGroup(runtime.caseGroup);
      clearOwnedGroup(runtime.hingeGroup);
      clearCachedCloneGroup(runtime.inventoryGroup);
      clearOwnedGroup(runtime.labelGroup);
      clearOwnedGroup(runtime.markerGroup);
      clearOwnedGroup(runtime.calibrationGroup);
      clearOwnedGroup(runtime.hitGroup);
      caseRootsRef.current.clear();
      runtime.render();

      Promise.allSettled(caseModels.map(async model => ({
        model,
        asset: await loadGltfAsset(model.url),
      })))
        .then(results => {
          if (!active || abortController.signal.aborted) return;
          const failures = results.filter(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          const loaded: LoadedCaseHalf[] = [];

          for (const result of results) {
            if (result.status === "rejected") continue;
            const { model, asset } = result.value;
            const root = instantiateGltfAsset(asset);
            root.name = `${case_.name}-${model.layer}-case-model`;
            applyCaseModelUnitScale(root, model.calibration ?? null);
            const pivot = new Group();
            pivot.name = `${model.layer}-case-half-pivot`;
            const content = new Group();
            content.name = `${model.layer}-case-half-content`;
            content.add(root);
            pivot.add(content);
            runtime.caseGroup.add(pivot);
            loaded.push({ layer: model.layer, root, pivot, content });
            caseRootsRef.current.set(model.layer, root);
          }

          if (loaded.length === 0) {
            const firstFailure = failures[0]?.reason;
            const failure = firstFailure instanceof Error
              ? firstFailure
              : new Error("The case models could not be loaded.");
            setStatusMessage("The case models could not be loaded.");
            callbacksRef.current.onFailure?.(failure);
            return;
          }

          const layout = layoutOpenCaseAssembly(loaded);
          if (layout.hinge) {
            const hingeMaterial = cloneRepresentativeCaseMaterial(loaded)
              ?? new MeshStandardMaterial({
                color: "#64748b",
                roughness: 0.36,
                metalness: 0.62,
              });
            const hinge = new Mesh(
              new CylinderGeometry(
                layout.hinge.radius,
                layout.hinge.radius,
                layout.hinge.length,
                32,
              ),
              hingeMaterial,
            );
            hinge.name = "centered-fake-hinge";
            hinge.rotation.z = Math.PI / 2;
            hinge.position.copy(layout.hinge.center);
            hinge.castShadow = true;
            hinge.receiveShadow = true;
            runtime.hingeGroup.add(hinge);
          }

          runtime.caseGroup.updateMatrixWorld(true);
          runtime.hingeGroup.updateMatrixWorld(true);
          let unavailableMappings = 0;
          for (const half of loaded) {
            const model = caseModels.find(candidate => candidate.layer === half.layer);
            const pickMeshes: Object3D[] = [];
            half.root.traverse(object => {
              if (!(object instanceof Mesh)) return;
              object.castShadow = true;
              object.receiveShadow = true;
              pickMeshes.push(object);
            });
            runtime.casePickMeshes.set(half.layer, pickMeshes);

            const mapping = mapCaseCompartmentAnchors({
              root: half.root,
              case_,
              layer: half.layer,
              calibration: model?.calibration ?? null,
            });
            if (mapping.status.source === "unavailable") unavailableMappings += 1;
            callbacksRef.current.onMappingStatus?.(half.layer, mapping.status);
            for (const [compartmentId, anchor] of Array.from(mapping.anchors.entries())) {
              runtime.anchors.set(compartmentId, anchor);
              const hit = createCompartmentHitTarget(anchor);
              runtime.hitGroup.add(hit);
              runtime.interactive.push({ object: hit, compartmentId });
            }
          }

          const calibrationRoot = caseRootsRef.current.get(calibrationLayerRef.current);
          if (calibrationRoot && calibrationPicksRef.current.size > 0) {
            renderCalibrationMarkers(runtime, calibrationRoot, calibrationPicksRef.current);
          }

          const assemblyBounds = new Box3().setFromObject(runtime.caseGroup);
          if (runtime.hingeGroup.children.length > 0) {
            assemblyBounds.union(new Box3().setFromObject(runtime.hingeGroup));
          }
          runtime.fitCamera(assemblyBounds);
          setAnchorRevision(current => current + 1);
          setStatusMessage(
            unavailableMappings > 0
              ? `Case assembly loaded. ${unavailableMappings === 1 ? "One half needs" : "Both halves need"} calibration.`
              : failures.length > 0
                ? "Available case half loaded; the other model could not be loaded."
                : loaded.length === 1
                  ? "Case half ready."
                  : "Open case assembly ready.",
          );
          runtime.render();
        })
        .catch(error => {
          if (!active || abortController.signal.aborted) return;
          const failure = error instanceof Error
            ? error
            : new Error("The case assembly could not be loaded.");
          setStatusMessage("The case assembly could not be loaded.");
          callbacksRef.current.onFailure?.(failure);
        });

      return () => {
        active = false;
        abortController.abort();
      };
    }, [case_, caseModels]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      // Calibration must keep the source surface visible and pickable. Number
      // mode otherwise substitutes labels for the case model.
      const caseIsVisible = calibrationActive || (showCaseModel && !showCompartmentNumbers);
      runtime.caseGroup.visible = caseIsVisible;
      runtime.hingeGroup.visible = caseIsVisible;
      runtime.render();
    }, [calibrationActive, showCaseModel, showCompartmentNumbers]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      clearOwnedGroup(runtime.labelGroup);
      if (showCompartmentNumbers && !calibrationActive && anchorRevision > 0) {
        for (const labelLayer of ["top", "bottom"] as const) {
          const visibleEntries = case_.compartments
            .filter(
              compartment =>
                compartment.layer === labelLayer && visibleIds.has(compartment.id),
            )
            .map(compartment => ({ id: compartment.id, position: compartment.position }));
          const layerAnchors = new Map(
            visibleEntries.flatMap(entry => {
              const anchor = runtime.anchors.get(entry.id);
              return anchor ? [[entry.id, anchor] as const] : [];
            }),
          );
          const labels = createCompartmentNumberLabels(
            visibleEntries,
            layerAnchors,
            selectedCompartmentId,
          );
          if (labels) runtime.labelGroup.add(labels);
        }
      }
      runtime.render();
    }, [
      anchorRevision,
      calibrationActive,
      case_.compartments,
      selectedCompartmentId,
      showCompartmentNumbers,
      visibleIds,
      visibleKey,
    ]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime || !selectedCompartmentId || anchorRevision === 0) return;
      focusRuntimeCompartment(runtime, selectedCompartmentId);
    }, [anchorRevision, selectedCompartmentId]);

    useEffect(() => {
      const runtime = runtimeRef.current;
      if (!runtime || anchorRevision === 0) return;
      const abortController = new AbortController();
      let active = true;
      clearCachedCloneGroup(runtime.inventoryGroup);
      clearOwnedGroup(runtime.markerGroup);
      runtime.interactive = runtime.interactive.filter(
        target => target.object.parent === runtime.hitGroup,
      );
      setWarnings([]);

      const visibleCompartments = case_.compartments.filter(
        compartment => visibleIds.has(compartment.id),
      );
      const localWarnings: string[] = [];
      const occurrencesByUrl = new Map<string, ComponentOccurrence[]>();
      const scalePolicy: ComponentScalePolicy = componentScaleMode === "actual"
        ? { mode: "actual" }
        : { mode: "display", targetLargestDimensionMeters: componentDisplaySizeMeters };

      const addMarker = (
        compartmentId: number,
        componentId: number,
        message?: string,
      ) => {
        const anchor = runtime.anchors.get(compartmentId);
        if (!anchor) return;
        const marker = createLocatorMarker(anchor);
        runtime.markerGroup.add(marker);
        runtime.interactive.push({ object: marker, compartmentId, componentId });
        if (message) localWarnings.push(message);
      };

      for (const compartment of visibleCompartments) {
        const component = compartment.component;
        const anchor = runtime.anchors.get(compartment.id);
        if (!component || !anchor) continue;
        if (!component.model3dUrl) {
          addMarker(compartment.id, component.id);
          continue;
        }

        const occurrence: ComponentOccurrence = {
          compartmentId: compartment.id,
          componentId: component.id,
          componentName: component.name,
          modelUrl: component.model3dUrl,
          anchor,
          selected: compartment.id === selectedCompartmentId,
          priority: compartment.id === selectedCompartmentId
            ? 0
            : priorityIds.has(compartment.id) ? 1 : 2,
          rotation: componentModelRotationQuaternion(component.model3dRotation),
        };
        const existing = occurrencesByUrl.get(component.model3dUrl) ?? [];
        existing.push(occurrence);
        occurrencesByUrl.set(component.model3dUrl, existing);
      }

      const requests = Array.from(occurrencesByUrl.entries()).map(([url, occurrences]) => ({
        url,
        context: occurrences,
        priority: Math.min(...occurrences.map(occurrence => occurrence.priority)),
      }));
      if (requests.length === 0) {
        setStatusMessage(runtime.anchors.size ? "Open case assembly ready." : "No compartment mapping available.");
        runtime.render();
        return () => {
          active = false;
          abortController.abort();
        };
      }

      setStatusMessage(`Loading ${requests.length} component ${requests.length === 1 ? "model" : "models"}…`);
      loadPrioritizedGltfAssets(requests, {
        signal: abortController.signal,
        concurrency: 4,
        onSettled: (result, completed, total) => {
          if (!active || abortController.signal.aborted) return;
          const occurrences = result.request.context;
          if (result.error || !result.asset) {
            for (const occurrence of occurrences) {
              addMarker(
                occurrence.compartmentId,
                occurrence.componentId,
                `${occurrence.componentName}: model failed to load; showing its location instead.`,
              );
            }
          } else {
            try {
              const template = result.asset.scene;
              const instancedPlacements = occurrences.length > 1
                ? addInstancedOccurrences(
                    template,
                    occurrences,
                    runtime.inventoryGroup,
                    runtime.interactive,
                    scalePolicy,
                  )
                : null;

              if (instancedPlacements) {
                instancedPlacements.forEach(({ occurrence, placement }) => {
                  const warning = placement.warning;
                  if (warning) localWarnings.push(`${occurrence.componentName}: ${warning}`);
                });
              } else {
                for (const occurrence of occurrences) {
                  const instance = instantiateGltfAsset(result.asset);
                  const placement = computeComponentPlacement(
                    instance,
                    occurrence.anchor,
                    FLOAT_GAP_METERS,
                    scalePolicy,
                    occurrence.rotation,
                  );
                  const wrapper = new Group();
                  wrapper.name = `${instance.name || occurrence.componentName}-placement`;
                  wrapper.position.copy(placement.translation);
                  wrapper.quaternion.copy(placement.rotation);
                  wrapper.scale.setScalar(placement.uniformScale);
                  wrapper.add(instance);
                  wrapper.updateMatrixWorld(true);
                  instance.traverse(object => {
                    if (!(object instanceof Mesh)) return;
                    object.castShadow = true;
                    object.receiveShadow = true;
                  });
                  runtime.inventoryGroup.add(wrapper);
                  runtime.interactive.push({
                    object: wrapper,
                    compartmentId: occurrence.compartmentId,
                    componentId: occurrence.componentId,
                  });
                  const warning = placement.warning;
                  if (warning) localWarnings.push(`${occurrence.componentName}: ${warning}`);
                }
              }
            } catch (error) {
              const detail = error instanceof Error ? error.message : "invalid model geometry";
              for (const occurrence of occurrences) {
                addMarker(
                  occurrence.compartmentId,
                  occurrence.componentId,
                  `${occurrence.componentName}: ${detail}; showing its location instead.`,
                );
              }
            }
          }

          setWarnings(Array.from(new Set(localWarnings)));
          setStatusMessage(
            completed === total
              ? "Component locations ready."
              : `Loaded ${completed} of ${total} component models…`,
          );
          runtime.render();
        },
      }).catch(error => {
        if (!active || abortController.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Component models could not be loaded.";
        localWarnings.push(message);
        setWarnings(Array.from(new Set(localWarnings)));
        setStatusMessage("Some component models could not be loaded.");
        runtime.render();
      });

      return () => {
        active = false;
        abortController.abort();
      };
    }, [
      anchorRevision,
      case_.compartments,
      componentDisplaySizeMeters,
      componentScaleMode,
      priorityIds,
      priorityKey,
      selectedCompartmentId,
      visibleIds,
      visibleKey,
    ]);

    const enterFullscreen = async () => {
      if (containerRef.current?.requestFullscreen) {
        await containerRef.current.requestFullscreen();
      }
    };

    return (
      <div
        ref={containerRef}
        className={`relative isolate overflow-hidden bg-slate-950 ${className ?? "h-full w-full"}`}
        tabIndex={0}
        aria-label={`Interactive 3D open-case assembly view of ${case_.name}`}
        onKeyDown={event => {
          if (event.key.toLocaleLowerCase() === "r") {
            event.preventDefault();
            runtimeRef.current?.resetCamera();
          }
          if (event.key.toLocaleLowerCase() === "f") {
            event.preventDefault();
            void enterFullscreen();
          }
        }}
      >
        <div ref={canvasHostRef} className="absolute inset-0" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3">
          <span className="rounded-md border border-slate-600/70 bg-slate-950/80 px-2.5 py-1.5 text-xs text-slate-200 shadow-sm backdrop-blur">
            {statusMessage}
          </span>
          <div className="pointer-events-auto flex gap-2">
            <button
              type="button"
              onClick={() => runtimeRef.current?.resetCamera()}
              className="rounded-md border border-slate-600 bg-slate-900/90 px-2.5 py-1.5 text-xs font-medium text-slate-100 shadow-sm hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              Reset view
            </button>
            <button
              type="button"
              onClick={() => void enterFullscreen()}
              className="rounded-md border border-slate-600 bg-slate-900/90 px-2.5 py-1.5 text-xs font-medium text-slate-100 shadow-sm hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              Fullscreen
            </button>
          </div>
        </div>

        {calibrationPickMode && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 rounded-lg border border-indigo-400/50 bg-indigo-950/90 px-3 py-2 text-center text-sm text-indigo-100 shadow-lg backdrop-blur">
            Click the case surface to record the {calibrationPickMode === "origin"
              ? "A1 center"
              : calibrationPickMode === "columnEnd"
                ? "last column in row A"
                : "first column in the last row"}.
          </div>
        )}

        {warnings.length > 0 && !calibrationPickMode && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 max-h-28 overflow-hidden rounded-lg border border-amber-400/40 bg-amber-950/90 px-3 py-2 text-xs text-amber-100 shadow-lg backdrop-blur">
            <p className="font-semibold">Model placement warning</p>
            <p className="mt-0.5 truncate" title={warnings.join(" ")}>
              {warnings[0]}{warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ""}
            </p>
          </div>
        )}

        <span className="sr-only" aria-live="polite">{statusMessage}</span>
      </div>
    );
  },
);

export default CaseInventoryScene;
