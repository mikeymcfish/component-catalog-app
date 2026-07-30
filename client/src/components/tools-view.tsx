import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import {
  Boxes,
  ExternalLink,
  Image as ImageIcon,
  MapPin,
  Pencil,
  Plus,
  Search,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Tool } from "@/lib/tools";

interface ToolsViewProps {
  onAddTool: () => void;
  onEditTool: (tool: Tool) => void;
}

interface ToolImageProps {
  tool: Tool;
  variant: "tile" | "detail";
}

interface ToolDetailDialogProps {
  tool: Tool | null;
  onClose: () => void;
  onEdit: (tool: Tool) => void;
  onDelete: (tool: Tool) => void;
}

function getToolSubtitle(tool: Tool) {
  return [tool.manufacturer, tool.modelNumber].filter(Boolean).join(" ");
}

function matchesSearch(tool: Tool, normalizedQuery: string) {
  return [
    tool.name,
    tool.category,
    tool.manufacturer,
    tool.modelNumber,
    tool.productUrl,
    tool.location,
    tool.capabilities,
    tool.notes,
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
}

function ToolImage({ tool, variant }: ToolImageProps) {
  const [failed, setFailed] = useState(false);
  const aspectClass = variant === "tile" ? "aspect-[4/3]" : "aspect-[16/9] max-h-72";

  if (!tool.imageUrl || failed) {
    return (
      <div
        className={`grid ${aspectClass} w-full place-items-center bg-gradient-to-br from-slate-50 to-blue-50 text-slate-400`}
        role="img"
        aria-label={`No image available for ${tool.name}`}
      >
        <ImageIcon className={variant === "tile" ? "h-8 w-8" : "h-10 w-10"} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className={`${aspectClass} w-full overflow-hidden bg-white`}>
      <img
        src={tool.imageUrl}
        alt={`${tool.name} product`}
        className={`h-full w-full object-contain ${variant === "tile" ? "p-2" : "p-4"}`}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function ToolDetailDialog({ tool, onClose, onEdit, onDelete }: ToolDetailDialogProps) {
  if (!tool) return null;

  const subtitle = getToolSubtitle(tool);

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] min-w-0 max-w-2xl overflow-x-hidden overflow-y-auto p-0">
        <div className="min-w-0 overflow-hidden rounded-t-lg border-b border-gray-100 bg-gray-50">
          <ToolImage key={tool.imageUrl ?? "empty"} tool={tool} variant="detail" />
        </div>

        <div className="min-w-0 space-y-5 px-6 pb-6">
          <DialogHeader className="min-w-0 pr-7">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="max-w-full rounded-full bg-blue-50 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-blue-700 [overflow-wrap:anywhere]">
                {tool.category}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
                <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
                {tool.quantity} {tool.quantity === 1 ? "unit" : "units"}
              </span>
            </div>
            <DialogTitle className="min-w-0 pt-1 text-2xl leading-tight text-gray-900 [overflow-wrap:anywhere]">
              {tool.name}
            </DialogTitle>
            <DialogDescription className="min-w-0 [overflow-wrap:anywhere]">
              {subtitle || "No manufacturer or model number recorded."}
            </DialogDescription>
          </DialogHeader>

          {tool.location ? (
            <p className="flex items-start gap-2 text-sm text-gray-600">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{tool.location}</span>
            </p>
          ) : null}

          <section aria-labelledby={`tool-${tool.id}-capabilities`}>
            <h3
              id={`tool-${tool.id}-capabilities`}
              className="text-xs font-bold uppercase tracking-wider text-blue-700"
            >
              Capabilities
            </h3>
            {tool.capabilities ? (
              <p className="mt-2 min-w-0 whitespace-pre-wrap rounded-xl border border-blue-100 bg-blue-50/70 p-4 text-sm leading-6 text-gray-700 [overflow-wrap:anywhere]">
                {tool.capabilities}
              </p>
            ) : (
              <p className="mt-2 rounded-xl border border-dashed border-gray-200 p-4 text-sm text-gray-400">
                No capabilities recorded yet.
              </p>
            )}
          </section>

          {tool.notes ? (
            <section aria-labelledby={`tool-${tool.id}-notes`}>
              <h3
                id={`tool-${tool.id}-notes`}
                className="text-xs font-bold uppercase tracking-wider text-gray-500"
              >
                Notes
              </h3>
              <p className="mt-2 min-w-0 whitespace-pre-wrap text-sm leading-6 text-gray-600 [overflow-wrap:anywhere]">
                {tool.notes}
              </p>
            </section>
          ) : null}

          <DialogFooter className="min-w-0 gap-2 border-t border-gray-100 pt-5 sm:justify-between sm:space-x-0">
            <div className="min-w-0">
              {tool.productUrl ? (
                <Button type="button" variant="outline" asChild>
                  <a href={tool.productUrl} target="_blank" rel="noreferrer">
                    Product page
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  </a>
                </Button>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onClose();
                  onEdit(tool);
                }}
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
                Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                className="text-red-600 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                onClick={() => {
                  onClose();
                  onDelete(tool);
                }}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </Button>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function ToolsView({ onAddTool, onEditTool }: ToolsViewProps) {
  const locationSearch = useSearch();
  const requestedSearch = useMemo(
    () => new URLSearchParams(locationSearch).get("search")?.trim() ?? "",
    [locationSearch],
  );
  const [searchQuery, setSearchQuery] = useState(requestedSearch);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [toolPendingDeletion, setToolPendingDeletion] = useState<Tool | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: tools = [],
    isLoading,
    isError,
  } = useQuery<Tool[]>({ queryKey: ["/api/tools"] });

  useEffect(() => {
    setSearchQuery(requestedSearch);
  }, [requestedSearch]);

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleTools = useMemo(() => {
    const matchingTools = normalizedQuery
      ? tools.filter((tool) => matchesSearch(tool, normalizedQuery))
      : [...tools];
    return matchingTools.sort((left, right) =>
      left.category.localeCompare(right.category) || left.name.localeCompare(right.name)
    );
  }, [normalizedQuery, tools]);

  const totalUnits = useMemo(
    () => visibleTools.reduce((total, tool) => total + tool.quantity, 0),
    [visibleTools],
  );

  const deleteMutation = useMutation({
    mutationFn: async (tool: Tool) => {
      await apiRequest("DELETE", `/api/tools/${tool.id}`);
      return tool;
    },
    onSuccess: (tool) => {
      setToolPendingDeletion(null);
      toast({ title: `${tool.name} deleted` });
    },
    onError: (error) => {
      toast({
        title: "Could not delete tool",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/tools"] });
    },
  });

  const hasTools = tools.length > 0;
  const hasMatches = visibleTools.length > 0;

  return (
    <section className="case-library" aria-labelledby="tools-title">
      <div className="case-library-heading-row">
        <div>
          <p className="case-library-eyebrow">Debugging resources</p>
          <h1 id="tools-title" className="case-library-title">Tools</h1>
          <p className="case-library-description">
            Catalog the test equipment, probes, and accessories available for troubleshooting.
          </p>
        </div>
        <Button className="case-library-add-button" onClick={onAddTool}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add tool
        </Button>
      </div>

      {hasTools ? (
        <div className="case-library-toolbar">
          <label className="case-library-search">
            <span className="sr-only">Search tools</span>
            <Search className="case-library-search-icon h-4 w-4" aria-hidden="true" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search by tool, category, model, capability, or location"
              className="case-library-search-input"
            />
          </label>
          <p className="case-library-count" aria-live="polite">
            {visibleTools.length} {visibleTools.length === 1 ? "tool" : "tools"}
            {totalUnits !== visibleTools.length ? ` / ${totalUnits} total units` : ""}
          </p>
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6" aria-label="Loading tools">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div
              key={index}
              className="aspect-[4/3] animate-pulse rounded-xl border border-gray-200 bg-white"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="case-library-empty">
          <div className="case-library-empty-icon" aria-hidden="true">
            <Wrench className="h-7 w-7" />
          </div>
          <h2>Tools could not be loaded</h2>
          <p>Check that the catalog server is running, then refresh this page.</p>
        </div>
      ) : hasMatches ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {visibleTools.map((tool) => {
            const isSearchMatch = Boolean(
              normalizedQuery && matchesSearch(tool, normalizedQuery),
            );
            return (
              <article
                key={tool.id}
                className={`h-full min-w-0 overflow-hidden rounded-xl bg-white transition hover:-translate-y-0.5 hover:shadow-md ${
                  isSearchMatch
                    ? "border border-blue-300 shadow-md ring-2 ring-blue-100"
                    : "border border-gray-200 shadow-sm hover:border-blue-200"
                }`}
              >
                <button
                  type="button"
                  className="group flex h-full min-w-0 w-full flex-col overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                  onClick={() => setSelectedTool(tool)}
                  aria-label={`View details for ${tool.name}`}
                  title={tool.name}
                >
                  <ToolImage key={tool.imageUrl ?? "empty"} tool={tool} variant="tile" />
                  <div className="flex h-16 w-full min-w-0 shrink-0 items-center border-t border-gray-100 px-3 py-2">
                    <h2
                      className="max-h-10 w-full min-w-0 overflow-hidden text-sm font-semibold leading-5 text-gray-900 transition-colors group-hover:text-blue-700"
                      style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 2,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {tool.name}
                    </h2>
                  </div>
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="case-library-empty">
          <div className="case-library-empty-icon" aria-hidden="true">
            {hasTools ? <Search className="h-7 w-7" /> : <Wrench className="h-7 w-7" />}
          </div>
          <h2>{hasTools ? "No matching tools" : "Your tool catalog is empty"}</h2>
          <p>
            {hasTools
              ? `Nothing matches "${searchQuery.trim()}". Try a model, capability, or location.`
              : "Add your test equipment so debugging guidance can account for what is available."}
          </p>
          {hasTools ? (
            <Button variant="outline" onClick={() => setSearchQuery("")}>Clear search</Button>
          ) : (
            <Button onClick={onAddTool}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add your first tool
            </Button>
          )}
        </div>
      )}

      <ToolDetailDialog
        tool={selectedTool}
        onClose={() => setSelectedTool(null)}
        onEdit={onEditTool}
        onDelete={setToolPendingDeletion}
      />

      <AlertDialog
        open={!!toolPendingDeletion}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleteMutation.isPending) setToolPendingDeletion(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100vw-2rem)] min-w-0 overflow-x-hidden">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tool?</AlertDialogTitle>
            <AlertDialogDescription className="[overflow-wrap:anywhere]">
              {toolPendingDeletion?.name} will no longer appear in the tool catalog or debugging suggestions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600"
              onClick={(event) => {
                event.preventDefault();
                if (toolPendingDeletion) deleteMutation.mutate(toolPendingDeletion);
              }}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete tool"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
