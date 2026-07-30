import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, RotateCw, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface KicadStatus {
  saved: {
    kicadDirectory: string | null;
    modelDirectories: string[];
  };
  detected: {
    installDirectory: string | null;
    cliPath: string | null;
    modelDirectories: string[];
  };
  effective: {
    installDirectory: string | null;
    cliPath: string | null;
    modelDirectories: string[];
  };
  cliAvailable: boolean;
  modelLibraryAvailable: boolean;
  index: {
    count: number;
    indexedAt: string | null;
    indexing: boolean;
    error: string | null;
  };
}

interface KicadSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

async function fetchKicadStatus() {
  const response = await fetch("/api/kicad/settings", { credentials: "include" });
  if (!response.ok) throw new Error("Failed to read KiCad settings");
  return response.json() as Promise<KicadStatus>;
}

export default function KicadSettingsDialog({ open, onOpenChange }: KicadSettingsDialogProps) {
  const [kicadDirectory, setKicadDirectory] = useState("");
  const [modelDirectories, setModelDirectories] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const statusQuery = useQuery({
    queryKey: ["/api/kicad/settings"],
    queryFn: fetchKicadStatus,
    enabled: open,
  });

  useEffect(() => {
    if (!statusQuery.data) return;
    setKicadDirectory(statusQuery.data.saved.kicadDirectory || "");
    setModelDirectories(statusQuery.data.saved.modelDirectories.join("\n"));
  }, [statusQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async ({ reset = false }: { reset?: boolean } = {}) => {
      const directories = reset
        ? []
        : modelDirectories.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      await apiRequest("PUT", "/api/kicad/settings", {
        kicadDirectory: reset ? null : kicadDirectory.trim() || null,
        modelDirectories: directories,
      });
      const response = await apiRequest("POST", "/api/kicad/models/reindex");
      return response.json() as Promise<KicadStatus>;
    },
    onSuccess: async data => {
      queryClient.setQueryData(["/api/kicad/settings"], data);
      await queryClient.invalidateQueries({ queryKey: ["/api/kicad/models"] });
      toast({
        title: "KiCad checked",
        description: data.modelLibraryAvailable
          ? `Indexed ${data.index.count.toLocaleString()} 3D models.`
          : "No KiCad model library was found. GLB uploads still work.",
      });
    },
    onError: error => {
      toast({
        title: "KiCad check failed",
        description: error instanceof Error ? error.message : "Settings could not be saved.",
        variant: "destructive",
      });
    },
  });

  const status = statusQuery.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>KiCad 3D Model Settings</DialogTitle>
          <DialogDescription>
            The app uses the detected KiCad installation by default. Set an override only when your library lives elsewhere.
          </DialogDescription>
        </DialogHeader>

        {statusQuery.isLoading ? (
          <div className="flex h-40 items-center justify-center text-sm text-gray-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading KiCad status…
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 rounded-lg border bg-slate-50 p-4 sm:grid-cols-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Converter</p>
                <Badge variant={status?.cliAvailable ? "default" : "secondary"} className="mt-2">
                  {status?.cliAvailable ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <XCircle className="mr-1 h-3 w-3" />}
                  {status?.cliAvailable ? "KiCad CLI ready" : "Not available"}
                </Badge>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Model library</p>
                <Badge variant={status?.modelLibraryAvailable ? "default" : "secondary"} className="mt-2">
                  {status?.modelLibraryAvailable ? "Found" : "Not found"}
                </Badge>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Index</p>
                <p className="mt-2 text-sm font-semibold">{status?.index.count.toLocaleString() || 0} models</p>
              </div>
            </div>

            {status?.detected.installDirectory && (
              <div className="rounded-md border border-blue-100 bg-blue-50 p-3 text-xs text-blue-900">
                Auto-detected: <span className="font-mono break-all">{status.detected.installDirectory}</span>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="kicad-directory">KiCad installation directory</Label>
              <Input
                id="kicad-directory"
                value={kicadDirectory}
                onChange={event => setKicadDirectory(event.target.value)}
                placeholder={status?.detected.installDirectory || "C:\\Program Files\\KiCad\\10.0"}
                autoComplete="off"
              />
              <p className="text-xs text-gray-500">Leave blank to use auto-detection.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="model-directories">Additional 3D model directories</Label>
              <Textarea
                id="model-directories"
                value={modelDirectories}
                onChange={event => setModelDirectories(event.target.value)}
                placeholder={"One absolute directory per line"}
                className="min-h-24 font-mono text-xs"
              />
            </div>

            {status?.index.error && <p className="text-sm text-amber-700">{status.index.error}</p>}
            {status?.effective.cliPath && (
              <p className="break-all text-xs text-gray-500">CLI: {status.effective.cliPath}</p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => saveMutation.mutate({ reset: true })}
            disabled={saveMutation.isPending}
          >
            Use defaults
          </Button>
          <Button
            type="button"
            onClick={() => saveMutation.mutate({})}
            disabled={statusQuery.isLoading || saveMutation.isPending}
          >
            {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
            Check KiCad & Reindex
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
