import type React from "react";
import type { ModelViewerElement } from "@google/model-viewer";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": React.DetailedHTMLProps<React.HTMLAttributes<ModelViewerElement>, ModelViewerElement> & {
        src?: string;
        alt?: string;
        loading?: "auto" | "lazy" | "eager";
        reveal?: "auto" | "interaction" | "manual";
        "camera-controls"?: boolean | string;
        "camera-orbit"?: string;
        "camera-target"?: string;
        orientation?: string;
        "environment-image"?: string;
        "interaction-prompt"?: string;
        "shadow-intensity"?: string;
        exposure?: string;
      };
    }
  }
}

export {};
