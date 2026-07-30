import { useState, useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Link, Minus, Plus, Upload, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { COMPONENT_CATEGORIES, PACKAGE_SIZES } from "@/lib/constants";
import Model3dField from "@/components/model-3d-field";
import {
  getModelAssetId,
  type ModelAsset,
  type ModelSelection,
} from "@/lib/model-3d";
import type { Component, Compartment } from "@shared/schema";
import {
  createComponentModelRotation,
  getComponentModelQuarterTurns,
  ZERO_COMPONENT_MODEL_QUARTER_TURNS,
  type ComponentModelQuarterTurns,
  type ComponentModelRotation,
} from "@shared/component-model-rotation";

const componentSchema = z.object({
  name: z.string().min(1, "Component name is required"),
  category: z.string().min(1, "Category is required"),
  packageSize: z.string().optional(),
  quantity: z.number().min(0, "Quantity must be positive"),
  minQuantity: z.number().min(1, "Minimum quantity must be at least 1").default(5),
  notes: z.string().optional(),
});

type ComponentFormData = z.infer<typeof componentSchema>;

interface EditComponentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  compartment?: Compartment;
  component?: Component;
  onSuccess: () => void;
}

export default function EditComponentDialog({
  isOpen,
  onClose,
  compartment,
  component,
  onSuccess,
}: EditComponentDialogProps) {
  const [datasheetFile, setDatasheetFile] = useState<File | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [datasheetUrl, setDatasheetUrl] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<ModelSelection>({ kind: "none" });
  const [modelRotation, setModelRotation] = useState<ComponentModelQuarterTurns>({
    ...ZERO_COMPONENT_MODEL_QUARTER_TURNS,
  });
  const [modelRotationEdited, setModelRotationEdited] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloadingLink, setDownloadingLink] = useState<"datasheet" | "photo" | null>(null);
  const datasheetInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<ComponentFormData>({
    resolver: zodResolver(componentSchema),
    defaultValues: {
      name: "",
      category: "",
      packageSize: "",
      quantity: 0,
      minQuantity: 5,
      notes: "",
    },
  });

  useEffect(() => {
    if (component) {
      // Extract package size from notes if it exists
      const packageMatch = component.notes?.match(/Package: ([^|]+)/);
      const packageSize = component.packageSize || (packageMatch ? packageMatch[1].trim() : "");

      // Convert categoryId back to category string
      const categoryMap = {
        1: 'resistor', 2: 'capacitor', 3: 'ic', 4: 'diode', 5: 'transistor',
        6: 'inductor', 7: 'crystal', 8: 'connector', 9: 'led', 10: 'switch',
        11: 'sensor', 12: 'other'
      };
      const category = categoryMap[component.categoryId as keyof typeof categoryMap] || 'other';

      form.reset({
        name: component.name,
        category: category,
        packageSize: packageSize,
        quantity: component.quantity,
        minQuantity: component.minQuantity || 5,
        notes: component.notes?.replace(/Package: [^|]+\s*\|\s*/, '').replace(/^\s*\|\s*/, '') || "",
      });
      setDatasheetUrl(component.datasheetUrl);
      setPhotoUrl(component.photoUrl);
      if (component.model3dUrl) {
        setModelSelection({
          kind: "existing",
          asset: {
            assetId: getModelAssetId(component.model3dUrl) || "",
            url: component.model3dUrl,
            name: component.model3dName || "3D model",
            source: component.model3dSource === "kicad" ? "kicad" : "upload",
          },
        });
        setModelRotation(getComponentModelQuarterTurns(component.model3dRotation));
        setModelRotationEdited(false);
      } else {
        setModelSelection({ kind: "none" });
        setModelRotation({ ...ZERO_COMPONENT_MODEL_QUARTER_TURNS });
        setModelRotationEdited(false);
      }
    } else {
      form.reset({
        name: "",
        category: "",
        packageSize: "",
        quantity: 0,
        minQuantity: 5,
        notes: "",
      });
      setDatasheetUrl(null);
      setPhotoUrl(null);
      setModelSelection({ kind: "none" });
      setModelRotation({ ...ZERO_COMPONENT_MODEL_QUARTER_TURNS });
      setModelRotationEdited(false);
    }

    setDatasheetFile(null);
    setPhotoFile(null);
    if (datasheetInputRef.current) datasheetInputRef.current.value = "";
    if (photoInputRef.current) photoInputRef.current.value = "";
  }, [component, form]);

  const createComponentMutation = useMutation({
    mutationFn: async (data: ComponentFormData & {
      compartmentId: number;
      datasheetUrl?: string | null;
      photoUrl?: string | null;
      model3dUrl?: string | null;
      model3dName?: string | null;
      model3dSource?: "kicad" | "upload" | null;
      model3dRotation?: ComponentModelRotation | null;
    }) => {
      const response = await apiRequest("POST", "/api/components", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      toast({ title: "Component created successfully" });
      onSuccess();
    },
    onError: () => {
      toast({ title: "Failed to create component", variant: "destructive" });
    },
  });

  const updateComponentMutation = useMutation({
    mutationFn: async (data: Partial<ComponentFormData> & {
      datasheetUrl?: string | null;
      photoUrl?: string | null;
      model3dUrl?: string | null;
      model3dName?: string | null;
      model3dSource?: "kicad" | "upload" | null;
      model3dRotation?: ComponentModelRotation | null;
    }) => {
      const response = await apiRequest("PATCH", `/api/components/${component!.id}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      toast({ title: "Component updated successfully" });
      onSuccess();
    },
    onError: () => {
      toast({ title: "Failed to update component", variant: "destructive" });
    },
  });

  const deleteComponentMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("DELETE", `/api/components/${component!.id}`);
      const result = await response.json();
      const modelAssetId = getModelAssetId(component?.model3dUrl);
      if (modelAssetId) {
        try {
          await apiRequest("DELETE", `/api/models/${modelAssetId}`);
        } catch {
          // Shared assets remain in place; failed cleanup does not undo component deletion.
        }
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      toast({ title: "Component deleted successfully" });
      onSuccess();
    },
    onError: () => {
      toast({ title: "Failed to delete component", variant: "destructive" });
    },
  });

  const uploadFile = async (file: File, type: "datasheet" | "photo") => {
    const formData = new FormData();
    formData.append(type, file);

    const response = await apiRequest("POST", `/api/upload/${type}`, formData);
    const result = await response.json();
    return result.url;
  };

  const prepareModel = async (): Promise<{ asset: ModelAsset | null; created: boolean }> => {
    if (modelSelection.kind === "none") return { asset: null, created: false };
    if (modelSelection.kind === "existing") return { asset: modelSelection.asset, created: false };

    if (modelSelection.kind === "upload") {
      const formData = new FormData();
      formData.append("model", modelSelection.file);
      const response = await apiRequest("POST", "/api/models/upload", formData);
      return { asset: await response.json() as ModelAsset, created: true };
    }

    const response = await apiRequest("POST", "/api/models/import-local", {
      modelId: modelSelection.model.id,
    });
    return { asset: await response.json() as ModelAsset, created: true };
  };

  const deleteModelAsset = async (assetId: string | null | undefined) => {
    if (!assetId) return;
    try {
      await apiRequest("DELETE", `/api/models/${assetId}`);
    } catch {
      // Cleanup is best-effort and reference-aware on the server.
    }
  };

  const isDirectImageUrl = (value: string) => {
    try {
      const url = new URL(value);
      return /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(url.pathname + url.search);
    } catch {
      return false;
    }
  };

  const downloadClipboardLink = async (type: "datasheet" | "photo") => {
    if (!navigator.clipboard?.readText) {
      toast({
        title: "Clipboard unavailable",
        description: "Paste the link into your browser first, then try again.",
        variant: "destructive",
      });
      return;
    }

    setDownloadingLink(type);
    let clipboardUrl = "";
    try {
      clipboardUrl = (await navigator.clipboard.readText()).trim();
      if (!clipboardUrl) {
        throw new Error("Clipboard is empty");
      }

      const response = await apiRequest("POST", `/api/download/${type}`, { url: clipboardUrl });
      const result = await response.json();

      if (type === "datasheet") {
        setDatasheetUrl(result.url);
        setDatasheetFile(null);
        if (datasheetInputRef.current) datasheetInputRef.current.value = "";
      } else {
        setPhotoUrl(result.url);
        setPhotoFile(null);
        if (photoInputRef.current) photoInputRef.current.value = "";
      }

      toast({
        title: `${type === "datasheet" ? "Datasheet" : "Photo"} linked`,
        description: "Downloaded and saved locally.",
      });
    } catch (error) {
      if (type === "photo" && isDirectImageUrl(clipboardUrl)) {
        setPhotoUrl(clipboardUrl);
        setPhotoFile(null);
        if (photoInputRef.current) photoInputRef.current.value = "";
        toast({
          title: "Photo linked directly",
          description: "The site blocked local download, so the image URL was saved directly.",
        });
        return;
      }

      toast({
        title: `Failed to paste ${type} link`,
        description: error instanceof Error ? error.message : "The clipboard link could not be downloaded.",
        variant: "destructive",
      });
    } finally {
      setDownloadingLink(null);
    }
  };

  const onSubmit = async (data: ComponentFormData) => {
    if (!compartment) return;

    setUploading(true);
    let preparedModel: { asset: ModelAsset | null; created: boolean } | null = null;
    try {
      let nextDatasheetUrl = datasheetUrl;
      let nextPhotoUrl = photoUrl;

      if (datasheetFile) {
        nextDatasheetUrl = await uploadFile(datasheetFile, "datasheet");
      }

      if (photoFile) {
        nextPhotoUrl = await uploadFile(photoFile, "photo");
      }

      preparedModel = await prepareModel();
      const originalModelAssetId = getModelAssetId(component?.model3dUrl);
      const effectiveModelRotation = !modelRotationEdited &&
        preparedModel.asset?.assetId === originalModelAssetId
        ? getComponentModelQuarterTurns(component?.model3dRotation)
        : modelRotation;
      const modelFields = {
        model3dUrl: preparedModel.asset?.url || null,
        model3dName: preparedModel.asset?.name || null,
        model3dSource: preparedModel.asset?.source || null,
        model3dRotation: preparedModel.asset
          ? createComponentModelRotation(preparedModel.asset.assetId, effectiveModelRotation)
          : null,
      };

      if (component) {
        await updateComponentMutation.mutateAsync({
          ...data,
          datasheetUrl: nextDatasheetUrl,
          photoUrl: nextPhotoUrl,
          ...modelFields,
        });
      } else {
        await createComponentMutation.mutateAsync({
          ...data,
          compartmentId: compartment.id,
          datasheetUrl: nextDatasheetUrl,
          photoUrl: nextPhotoUrl,
          ...modelFields,
        });
      }

      const oldAssetId = getModelAssetId(component?.model3dUrl);
      if (oldAssetId && oldAssetId !== preparedModel.asset?.assetId) {
        await deleteModelAsset(oldAssetId);
      }
    } catch (error) {
      if (preparedModel?.created && preparedModel.asset?.assetId !== getModelAssetId(component?.model3dUrl)) {
        await deleteModelAsset(preparedModel.asset?.assetId);
      }
      toast({
        title: "Component was not saved",
        description: error instanceof Error ? error.message : "A file could not be prepared.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  const adjustQuantity = (delta: number) => {
    const currentQuantity = form.getValues("quantity");
    const newQuantity = Math.max(0, currentQuantity + delta);
    form.setValue("quantity", newQuantity);
  };

  const handleFileChange = (file: File | null, type: "datasheet" | "photo") => {
    if (type === "datasheet") {
      setDatasheetFile(file);
    } else {
      setPhotoFile(file);
    }
  };

  const clearAsset = (type: "datasheet" | "photo") => {
    if (type === "datasheet") {
      setDatasheetFile(null);
      setDatasheetUrl(null);
      if (datasheetInputRef.current) datasheetInputRef.current.value = "";
    } else {
      setPhotoFile(null);
      setPhotoUrl(null);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {component ? "Edit" : "Add"} Component -
            <span className="font-mono text-blue-600 ml-1">{compartment?.position}</span>
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Component Name/Value</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., 10kΩ Resistor" {...field} autoComplete="off" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {COMPONENT_CATEGORIES.map((category) => (
                        <SelectItem key={category.value} value={category.value}>
                          <div className="flex items-center space-x-2">
                            <div
                              className="w-3 h-3 rounded-full"
                              style={{ backgroundColor: category.color }}
                            />
                            <span>{category.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="packageSize"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Package/Size</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g., 0805, SOIC-8, custom tray"
                      list="package-size-options"
                      {...field}
                      value={field.value || ""}
                    />
                  </FormControl>
                  <datalist id="package-size-options">
                    {PACKAGE_SIZES.map((size) => (
                      <option key={size} value={size} />
                    ))}
                  </datalist>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="quantity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Quantity</FormLabel>
                  <FormControl>
                    <div className="flex items-center space-x-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => adjustQuantity(-1)}
                        className="w-8 h-8 p-0"
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                        className="text-center"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => adjustQuantity(1)}
                        className="w-8 h-8 p-0"
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="minQuantity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Minimum Quantity</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...field}
                      onChange={(e) => field.onChange(parseInt(e.target.value) || 5)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* File Uploads */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Datasheet</label>
                <div className="border-2 border-dashed border-gray-300 rounded-md p-3 text-center hover:border-blue-400 cursor-pointer transition-colors duration-200">
                  <input
                    ref={datasheetInputRef}
                    type="file"
                    accept=".pdf"
                    onChange={(e) => handleFileChange(e.target.files?.[0] || null, "datasheet")}
                    className="hidden"
                    id="datasheet-upload"
                  />
                  <label htmlFor="datasheet-upload" className="cursor-pointer">
                    <Upload className="mx-auto h-4 w-4 text-gray-400 mb-1" />
                    <p className="text-xs text-gray-500">
                      {datasheetFile ? datasheetFile.name : datasheetUrl ? datasheetUrl : "Drop PDF or click"}
                    </p>
                  </label>
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => downloadClipboardLink("datasheet")}
                    disabled={downloadingLink !== null || uploading}
                    className="flex-1"
                  >
                    <Link className="h-3 w-3 mr-2" />
                    {downloadingLink === "datasheet" ? "Downloading..." : "Paste Link"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => clearAsset("datasheet")}
                    disabled={downloadingLink !== null || uploading || (!datasheetFile && !datasheetUrl)}
                    title="Clear datasheet"
                    className="px-2"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Photo</label>
                <div className="border-2 border-dashed border-gray-300 rounded-md p-3 text-center hover:border-blue-400 cursor-pointer transition-colors duration-200">
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleFileChange(e.target.files?.[0] || null, "photo")}
                    className="hidden"
                    id="photo-upload"
                  />
                  <label htmlFor="photo-upload" className="cursor-pointer">
                    <Upload className="mx-auto h-4 w-4 text-gray-400 mb-1" />
                    <p className="text-xs text-gray-500">
                      {photoFile ? photoFile.name : photoUrl ? photoUrl : "Drop image or click"}
                    </p>
                  </label>
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => downloadClipboardLink("photo")}
                    disabled={downloadingLink !== null || uploading}
                    className="flex-1"
                  >
                    <Link className="h-3 w-3 mr-2" />
                    {downloadingLink === "photo" ? "Downloading..." : "Paste Link"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => clearAsset("photo")}
                    disabled={downloadingLink !== null || uploading || (!photoFile && !photoUrl)}
                    title="Clear photo"
                    className="px-2"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>

            <Model3dField
              selection={modelSelection}
              onChange={selection => {
                setModelSelection(selection);
                setModelRotation({ ...ZERO_COMPONENT_MODEL_QUARTER_TURNS });
                setModelRotationEdited(false);
              }}
              rotation={modelRotation}
              onRotationChange={rotation => {
                setModelRotation(rotation);
                setModelRotationEdited(true);
              }}
              defaultSearch={form.watch("name")}
              disabled={uploading}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Optional notes..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Action Buttons */}
            <div className="flex space-x-3 pt-4">
              <Button type="button" variant="outline" onClick={onClose} className="flex-1">
                Cancel
              </Button>
              {component && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => deleteComponentMutation.mutate()}
                  disabled={deleteComponentMutation.isPending}
                >
                  Delete
                </Button>
              )}
              <Button
                type="submit"
                className="flex-1"
                disabled={createComponentMutation.isPending || updateComponentMutation.isPending || uploading || downloadingLink !== null}
              >
                {uploading ? "Uploading..." : component ? "Update" : "Create"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
