import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Box, Image as ImageIcon, Trash2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Case } from "@shared/schema";

type ImageVariant = "closed" | "open";

interface CaseImageManagerDialogProps {
  case_: Case | null;
  isOpen: boolean;
  onClose: () => void;
}

interface ImageSelection {
  file: File | null;
  remove: boolean;
}

interface ModelSelection {
  file: File | null;
  remove: boolean;
}

const emptySelection: ImageSelection = { file: null, remove: false };
const emptyModelSelection: ModelSelection = { file: null, remove: false };
const acceptedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxImageSize = 10 * 1024 * 1024;
const maxModelSize = 50 * 1024 * 1024;

function useImagePreview(file: File | null, existingUrl: string | null | undefined, remove: boolean) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (remove) {
      setPreviewUrl(null);
      return;
    }

    if (!file) {
      setPreviewUrl(existingUrl || null);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [existingUrl, file, remove]);

  return previewUrl;
}

interface ImagePickerProps {
  id: string;
  label: string;
  description: string;
  previewUrl: string | null;
  fileName: string | null;
  disabled: boolean;
  onSelect: (file: File) => void;
  onRemove: () => void;
}

function ImagePicker({
  id,
  label,
  description,
  previewUrl,
  fileName,
  disabled,
  onSelect,
  onRemove,
}: ImagePickerProps) {
  return (
    <section className="case-image-picker">
      <div className="case-image-picker-heading">
        <div>
          <h3>{label}</h3>
          <p>{description}</p>
        </div>
        {previewUrl && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={disabled}
            className="case-image-remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </Button>
        )}
      </div>

      <label htmlFor={id} className="case-image-dropzone">
        <input
          id={id}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onSelect(file);
            event.target.value = "";
          }}
          className="sr-only"
        />
        {previewUrl ? (
          <img src={previewUrl} alt={`${label} preview`} />
        ) : (
          <div className="case-image-empty-preview">
            <ImageIcon className="h-7 w-7" />
            <span>No image yet</span>
          </div>
        )}
        <span className="case-image-upload-cue">
          <Upload className="h-4 w-4" />
          {fileName || "Choose JPEG, PNG, or WebP"}
        </span>
      </label>
    </section>
  );
}

interface ModelPickerProps {
  id: string;
  label: string;
  description: string;
  existingName: string | null | undefined;
  selection: ModelSelection;
  disabled: boolean;
  onSelect: (file: File) => void;
  onRemove: () => void;
}

function ModelPicker({
  id,
  label,
  description,
  existingName,
  selection,
  disabled,
  onSelect,
  onRemove,
}: ModelPickerProps) {
  const displayName = selection.file?.name || (selection.remove ? null : existingName);

  return (
    <section className="case-model-picker">
      <div className="case-model-picker-heading">
        <div className="case-model-picker-icon"><Box className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <h3>{label}</h3>
          <p>{description}</p>
        </div>
      </div>

      {displayName ? (
        <div className="case-model-current">
          <div className="min-w-0">
            <span>3D model ready</span>
            <strong title={displayName}>{displayName}</strong>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onRemove} disabled={disabled}>
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </Button>
        </div>
      ) : (
        <p className="case-model-empty">No model added for this half.</p>
      )}

      <label htmlFor={id} className="case-model-upload">
        <input
          id={id}
          type="file"
          accept=".glb,model/gltf-binary"
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onSelect(file);
            event.target.value = "";
          }}
        />
        <Upload className="h-4 w-4" />
        {displayName ? "Replace GLB" : "Choose GLB"}
      </label>
    </section>
  );
}

export default function CaseImageManagerDialog({ case_, isOpen, onClose }: CaseImageManagerDialogProps) {
  const [closedSelection, setClosedSelection] = useState<ImageSelection>(emptySelection);
  const [openSelection, setOpenSelection] = useState<ImageSelection>(emptySelection);
  const [topModelSelection, setTopModelSelection] = useState<ModelSelection>(emptyModelSelection);
  const [bottomModelSelection, setBottomModelSelection] = useState<ModelSelection>(emptyModelSelection);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (!isOpen) return;
    setClosedSelection(emptySelection);
    setOpenSelection(emptySelection);
    setTopModelSelection(emptyModelSelection);
    setBottomModelSelection(emptyModelSelection);
  }, [case_?.id, isOpen]);

  const closedPreview = useImagePreview(
    closedSelection.file,
    case_?.closedImageUrl,
    closedSelection.remove,
  );
  const openPreview = useImagePreview(
    openSelection.file,
    case_?.openImageUrl,
    openSelection.remove,
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!case_) return;

      const saveVariant = async (
        variant: ImageVariant,
        selection: ImageSelection,
        existingUrl: string | null | undefined,
      ) => {
        if (selection.file) {
          const formData = new FormData();
          formData.append("image", selection.file);
          await apiRequest("POST", `/api/cases/${case_.id}/images/${variant}`, formData);
          return;
        }

        if (selection.remove && existingUrl) {
          await apiRequest("DELETE", `/api/cases/${case_.id}/images/${variant}`);
        }
      };

      await saveVariant("closed", closedSelection, case_.closedImageUrl);
      await saveVariant("open", openSelection, case_.openImageUrl);

      const saveModel = async (
        part: "top" | "bottom",
        selection: ModelSelection,
        existingUrl: string | null | undefined,
      ) => {
        if (selection.file) {
          const formData = new FormData();
          formData.append("model", selection.file);
          await apiRequest("POST", `/api/cases/${case_.id}/models/${part}`, formData);
          return;
        }

        if (selection.remove && existingUrl) {
          await apiRequest("DELETE", `/api/cases/${case_.id}/models/${part}`);
        }
      };

      await saveModel("top", topModelSelection, case_.topModel3dUrl);
      await saveModel("bottom", bottomModelSelection, case_.bottomModel3dUrl);
    },
    onSuccess: () => {
      if (!case_) return;
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cases", case_.id] });
      toast({
        title: "Case media saved",
        description: "Photos and 3D case models are up to date.",
      });
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Could not save case media",
        description: error instanceof Error ? error.message : "The upload failed.",
        variant: "destructive",
      });
    },
    onSettled: () => {
      if (!case_) return;
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cases", case_.id] });
    },
  });

  const selectFile = (variant: ImageVariant, file: File) => {
    if (!acceptedImageTypes.has(file.type)) {
      toast({
        title: "Unsupported image",
        description: "Choose a JPEG, PNG, or WebP image.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > maxImageSize) {
      toast({
        title: "Image is too large",
        description: "Case images must be 10 MB or smaller.",
        variant: "destructive",
      });
      return;
    }

    const selection = { file, remove: false };
    if (variant === "closed") setClosedSelection(selection);
    else setOpenSelection(selection);
  };

  const removeImage = (variant: ImageVariant) => {
    const selection = { file: null, remove: true };
    if (variant === "closed") setClosedSelection(selection);
    else setOpenSelection(selection);
  };

  const selectModel = (part: "top" | "bottom", file: File) => {
    if (!file.name.toLowerCase().endsWith(".glb")) {
      toast({
        title: "Unsupported model",
        description: "Case models must be GLB files.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > maxModelSize) {
      toast({
        title: "Model is too large",
        description: "Case GLB files must be 50 MB or smaller.",
        variant: "destructive",
      });
      return;
    }

    const selection = { file, remove: false };
    if (part === "top") setTopModelSelection(selection);
    else setBottomModelSelection(selection);
  };

  const removeModel = (part: "top" | "bottom") => {
    const selection = { file: null, remove: true };
    if (part === "top") setTopModelSelection(selection);
    else setBottomModelSelection(selection);
  };

  const isSaving = saveMutation.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Case media{case_ ? ` - ${case_.name}` : ""}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="photos" className="case-media-tabs">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="photos">Case photos</TabsTrigger>
            <TabsTrigger value="models">3D case models</TabsTrigger>
          </TabsList>

          <TabsContent value="photos" className="mt-4 space-y-4">
            <p className="case-image-dialog-copy">
              Use similar framing for both photos so the closed-to-open rollover feels seamless.
            </p>
            <div className="case-image-picker-grid">
              <ImagePicker
                id="closed-case-image"
                label="Closed case"
                description="Shown by default in the Case Library."
                previewUrl={closedPreview}
                fileName={closedSelection.file?.name || null}
                disabled={isSaving}
                onSelect={(file) => selectFile("closed", file)}
                onRemove={() => removeImage("closed")}
              />
              <ImagePicker
                id="open-case-image"
                label="Open case"
                description="Optional rollover preview for desktop and keyboard focus."
                previewUrl={openPreview}
                fileName={openSelection.file?.name || null}
                disabled={isSaving}
                onSelect={(file) => selectFile("open", file)}
                onRemove={() => removeImage("open")}
              />
            </div>
          </TabsContent>

          <TabsContent value="models" className="mt-4 space-y-4">
            <p className="case-image-dialog-copy">
              Add the two GLBs independently. A case may have either half or both halves.
            </p>
            <div className="case-model-picker-grid">
              <ModelPicker
                id="top-case-model"
                label="Top GLB"
                description="The lid or upper half of the physical case."
                existingName={case_?.topModel3dName || (case_?.topModel3dUrl ? "Top case model" : null)}
                selection={topModelSelection}
                disabled={isSaving}
                onSelect={(file) => selectModel("top", file)}
                onRemove={() => removeModel("top")}
              />
              <ModelPicker
                id="bottom-case-model"
                label="Bottom GLB"
                description="The base or lower half of the physical case."
                existingName={case_?.bottomModel3dName || (case_?.bottomModel3dUrl ? "Bottom case model" : null)}
                selection={bottomModelSelection}
                disabled={isSaving}
                onSelect={(file) => selectModel("bottom", file)}
                onRemove={() => removeModel("bottom")}
              />
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => saveMutation.mutate()} disabled={!case_ || isSaving}>
            {isSaving ? "Saving media..." : "Save media"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
