import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Check, FolderSearch, Loader2, RotateCw, Settings, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  getSelectionName,
  type KicadModelResult,
  type ModelSelection,
} from "@/lib/model-3d";
import KicadSettingsDialog from "@/components/kicad-settings-dialog";
import Model3dViewer from "@/components/model-3d-viewer";
import {
  rotateComponentModelQuarterTurn,
  ZERO_COMPONENT_MODEL_QUARTER_TURNS,
  type ComponentModelQuarterTurns,
  type ComponentModelRotationAxis,
} from "@shared/component-model-rotation";

interface Model3dFieldProps {
  selection: ModelSelection;
  onChange: (selection: ModelSelection) => void;
  rotation: ComponentModelQuarterTurns;
  onRotationChange: (rotation: ComponentModelQuarterTurns) => void;
  defaultSearch?: string;
  disabled?: boolean;
}

interface SearchResponse {
  results: KicadModelResult[];
  index: {
    count: number;
    indexedAt: string | null;
    indexing: boolean;
    error: string | null;
  };
}

const acceptedExtensions = new Set(["step", "stp", "wrl", "glb"]);

export default function Model3dField({
  selection,
  onChange,
  rotation,
  onRotationChange,
  defaultSearch = "",
  disabled = false,
}: Model3dFieldProps) {
  const [query, setQuery] = useState(defaultSearch);
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const defaultSearchAppliedRef = useRef(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (defaultSearchAppliedRef.current || !defaultSearch.trim()) return;
    setQuery(defaultSearch.trim());
    defaultSearchAppliedRef.current = true;
  }, [defaultSearch]);

  const searchQuery = useQuery({
    queryKey: ["/api/kicad/models", submittedQuery],
    enabled: submittedQuery !== null,
    queryFn: async () => {
      const response = await fetch(`/api/kicad/models?q=${encodeURIComponent(submittedQuery || "")}&limit=30`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("KiCad models could not be searched");
      return response.json() as Promise<SearchResponse>;
    },
  });

  const chooseFile = (file: File | null) => {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    if (!acceptedExtensions.has(extension)) {
      toast({ title: "Unsupported model", description: "Choose a STEP, STP, WRL, or GLB file.", variant: "destructive" });
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      toast({ title: "Model is too large", description: "The maximum upload size is 50MB.", variant: "destructive" });
      return;
    }
    onChange({ kind: "upload", file });
  };

  const checkKicad = async () => {
    setReindexing(true);
    try {
      const response = await apiRequest("POST", "/api/kicad/models/reindex");
      const status = await response.json();
      toast({
        title: "KiCad checked",
        description: status.modelLibraryAvailable
          ? `Indexed ${status.index.count.toLocaleString()} 3D models.`
          : "No local model library was found. You can still upload a GLB.",
      });
      queryClient.setQueryData(["/api/kicad/settings"], status);
      await queryClient.invalidateQueries({ queryKey: ["/api/kicad/models"] });
      setSubmittedQuery(query.trim());
    } catch (error) {
      toast({
        title: "KiCad check failed",
        description: error instanceof Error ? error.message : "Could not index the model library.",
        variant: "destructive",
      });
    } finally {
      setReindexing(false);
    }
  };

  const selectedName = getSelectionName(selection);
  const rotationAxes: Array<{ axis: ComponentModelRotationAxis; label: string; turns: number }> = [
    { axis: "x", label: "X", turns: rotation.xQuarterTurns },
    { axis: "y", label: "Y", turns: rotation.yQuarterTurns },
    { axis: "z", label: "Z", turns: rotation.zQuarterTurns },
  ];
  const hasRotation = rotationAxes.some(({ turns }) => turns !== 0);

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center text-sm font-medium text-gray-900">
            <Box className="mr-2 h-4 w-4" /> 3D Model
          </h3>
          <p className="mt-1 text-xs text-gray-500">Saved as a browser-ready GLB; uploaded source files are discarded.</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setSettingsOpen(true)} disabled={disabled}>
          <Settings className="mr-2 h-4 w-4" /> Settings
        </Button>
      </div>

      {selectedName && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-emerald-900">{selectedName}</p>
            <p className="text-xs text-emerald-700">
              {selection.kind === "existing" ? "Current model" : "Ready to convert when you save"}
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ kind: "none" })} disabled={disabled}>
            <X className="h-4 w-4" /><span className="sr-only">Remove 3D model</span>
          </Button>
        </div>
      )}

      {selection.kind !== "none" && (
        <div className="space-y-3 rounded-md border border-indigo-200 bg-indigo-50/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-indigo-950">Model orientation</p>
              <p className="text-xs text-indigo-700">
                Each click rotates the model 90&deg; around that axis. Save the component to keep the change.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onRotationChange({ ...ZERO_COMPONENT_MODEL_QUARTER_TURNS })}
              disabled={disabled || !hasRotation}
            >
              Reset orientation
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Rotate component model">
            {rotationAxes.map(({ axis, label, turns }) => (
              <Button
                key={axis}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onRotationChange(rotateComponentModelQuarterTurn(rotation, axis))}
                disabled={disabled}
                aria-label={`Rotate ${label} axis by 90 degrees; currently ${turns * 90} degrees`}
                className="gap-1.5 bg-white"
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                {label} +90&deg;
                <span className="text-xs font-normal text-slate-500">({turns * 90}&deg;)</span>
              </Button>
            ))}
          </div>
          {selection.kind === "existing" && (
            <Model3dViewer
              src={selection.asset.url}
              name={selectedName || "component"}
              rotation={rotation}
              compact
            />
          )}
          {selection.kind !== "existing" && (
            <p className="text-xs text-indigo-700">
              The corrected orientation will be previewable after this model is saved as a GLB.
            </p>
          )}
        </div>
      )}

      <Tabs defaultValue="upload">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="upload">Upload</TabsTrigger>
          <TabsTrigger value="kicad">KiCad Library</TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".step,.stp,.wrl,.glb"
            className="hidden"
            onChange={event => chooseFile(event.target.files?.[0] || null)}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            onDragEnter={event => { event.preventDefault(); setDragging(true); }}
            onDragOver={event => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={event => {
              event.preventDefault();
              setDragging(false);
              chooseFile(event.dataTransfer.files?.[0] || null);
            }}
            className={`flex w-full flex-col items-center justify-center rounded-md border border-dashed p-5 text-center transition-colors ${dragging ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-slate-50 hover:bg-slate-100"}`}
          >
            <Upload className="mb-2 h-5 w-5 text-slate-500" />
            <span className="text-sm font-medium">Drop a model or click to browse</span>
            <span className="mt-1 text-xs text-slate-500">STEP, STP, WRL, or GLB · 50MB maximum</span>
          </button>
        </TabsContent>

        <TabsContent value="kicad" className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setSubmittedQuery(query.trim());
                }
              }}
              placeholder="Search by part or package name"
              disabled={disabled}
            />
            <Button type="button" variant="outline" onClick={() => setSubmittedQuery(query.trim())} disabled={disabled || searchQuery.isFetching}>
              {searchQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderSearch className="h-4 w-4" />}
              <span className="sr-only">Search KiCad models</span>
            </Button>
          </div>

          <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
            <span>
              {searchQuery.data?.index.indexedAt
                ? `${searchQuery.data.index.count.toLocaleString()} indexed models`
                : "Run Check KiCad to discover the local library."}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={checkKicad} disabled={disabled || reindexing}>
              {reindexing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Check KiCad
            </Button>
          </div>

          {searchQuery.isError && <p className="text-sm text-red-600">{searchQuery.error.message}</p>}
          {searchQuery.data?.index.error && <p className="text-sm text-amber-700">{searchQuery.data.index.error}</p>}

          {searchQuery.data && (
            <ScrollArea className="h-48 rounded-md border">
              <div className="divide-y">
                {searchQuery.data.results.map(model => {
                  const selected = selection.kind === "kicad" && selection.model.id === model.id;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => onChange({ kind: "kicad", model })}
                      className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-slate-50"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{model.name}</p>
                        <p className="truncate text-xs text-gray-500">{model.relativePath}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="secondary">{model.extension.toUpperCase()}</Badge>
                        {selected && <Check className="h-4 w-4 text-emerald-600" />}
                      </div>
                    </button>
                  );
                })}
                {searchQuery.data.results.length === 0 && (
                  <p className="p-6 text-center text-sm text-gray-500">No matching KiCad models.</p>
                )}
              </div>
            </ScrollArea>
          )}
        </TabsContent>
      </Tabs>

      <KicadSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
