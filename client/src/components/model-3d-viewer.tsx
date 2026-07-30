import { useEffect, useRef, useState } from "react";
import type { ModelViewerElement } from "@google/model-viewer";
import { Maximize2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ZERO_COMPONENT_MODEL_QUARTER_TURNS,
  type ComponentModelQuarterTurns,
} from "@shared/component-model-rotation";

interface Model3dViewerProps {
  src: string;
  name: string;
  rotation?: ComponentModelQuarterTurns;
  compact?: boolean;
}

export default function Model3dViewer({
  src,
  name,
  rotation = ZERO_COMPONENT_MODEL_QUARTER_TURNS,
  compact = false,
}: Model3dViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ModelViewerElement>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // model-viewer parses orientation as roll/pitch/yaw, then applies YXZ.
  // Z/X/Y here matches the Three.js correction used in the case scene.
  const orientation = [
    `${rotation.zQuarterTurns * 90}deg`,
    `${rotation.xQuarterTurns * 90}deg`,
    `${rotation.yQuarterTurns * 90}deg`,
  ].join(" ");

  useEffect(() => {
    let mounted = true;
    import("@google/model-viewer")
      .then(() => {
        if (mounted) setViewerReady(true);
      })
      .catch(() => {
        if (mounted) {
          setLoading(false);
          setFailed(true);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    setLoading(true);
    setFailed(false);
    const handleLoad = () => setLoading(false);
    const handleError = () => {
      setLoading(false);
      setFailed(true);
    };
    viewer.addEventListener("load", handleLoad);
    viewer.addEventListener("error", handleError);
    if (viewer.loaded) handleLoad();
    return () => {
      viewer.removeEventListener("load", handleLoad);
      viewer.removeEventListener("error", handleError);
    };
  }, [orientation, src, viewerReady]);

  const resetCamera = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.cameraOrbit = "0deg 75deg auto";
    viewer.cameraTarget = "auto auto auto";
    viewer.resetTurntableRotation(0);
    viewer.jumpCameraToGoal();
  };

  const openFullscreen = async () => {
    if (containerRef.current?.requestFullscreen) {
      await containerRef.current.requestFullscreen();
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden rounded-md border border-gray-200 bg-gradient-to-b from-slate-100 to-slate-200 fullscreen:h-screen ${
        compact ? "h-56 min-h-56" : "h-[60vh] min-h-80"
      }`}
    >
      {viewerReady && (
        <model-viewer
          ref={viewerRef}
          key={`${src}:${orientation}`}
          src={src}
          orientation={orientation}
          alt={`Interactive 3D model of ${name}`}
          loading="eager"
          camera-controls
          camera-orbit="0deg 75deg auto"
          camera-target="auto auto auto"
          environment-image="neutral"
          interaction-prompt="auto"
          shadow-intensity="1"
          exposure="1"
          className="h-full w-full"
          style={{ display: "block", width: "100%", height: "100%" }}
        />
      )}

      {loading && !failed && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-100/80 text-sm text-slate-600">
          Loading 3D model…
        </div>
      )}

      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-50 p-6 text-center text-sm text-slate-600">
          This 3D model could not be displayed. Replace it in edit mode and try again.
        </div>
      )}

      <div className="absolute right-3 top-3 flex gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={resetCamera} disabled={loading || failed}>
          <RotateCcw className="mr-2 h-4 w-4" />
          Reset view
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={openFullscreen} disabled={failed}>
          <Maximize2 className="mr-2 h-4 w-4" />
          Fullscreen
        </Button>
      </div>
    </div>
  );
}
