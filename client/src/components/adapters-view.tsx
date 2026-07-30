import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import {
  Boxes,
  Cable,
  ExternalLink,
  Image as ImageIcon,
  Info,
  MapPin,
  Pencil,
  Plus,
  Search,
  Trash2,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AdapterEndpointFlow from "@/components/adapter-endpoint-flow";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Adapter } from "@/lib/adapters";

interface AdaptersViewProps {
  onAddAdapter: () => void;
  onEditAdapter: (adapter: Adapter) => void;
}

function getAdapterSubtitle(adapter: Adapter) {
  return [adapter.manufacturer, adapter.modelNumber].filter(Boolean).join(" ");
}

function getAdapterConnectionLabel(adapter: Adapter) {
  return `${adapter.endpointA || "endpoint A not recorded"} to ${adapter.endpointB || "endpoint B not recorded"}`;
}

function matchesSearch(adapter: Adapter, normalizedQuery: string) {
  return [
    adapter.name,
    adapter.category,
    adapter.manufacturer,
    adapter.modelNumber,
    adapter.productUrl,
    adapter.endpointA,
    adapter.endpointAType,
    adapter.endpointB,
    adapter.endpointBType,
    adapter.location,
    adapter.compatibility,
    adapter.notes,
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
}

function AdapterThumbnail({ adapter, large = false }: { adapter: Adapter; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const sizeClass = large ? "aspect-[4/3] w-full" : "h-20 w-20 shrink-0";

  if (!adapter.imageUrl || failed) {
    return (
      <div className={`grid place-items-center rounded-xl border border-gray-100 bg-gradient-to-br from-slate-50 to-violet-50 text-slate-400 ${sizeClass}`}>
        <div className="text-center">
          <ImageIcon className={`${large ? "h-9 w-9" : "h-6 w-6"} mx-auto`} aria-hidden="true" />
          {large ? <p className="mt-2 text-xs font-medium">No adapter image</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`overflow-hidden rounded-xl border border-gray-100 bg-white ${sizeClass}`}>
      <img
        src={adapter.imageUrl}
        alt={`${adapter.name} product`}
        className="h-full w-full object-contain p-2"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

interface AdapterDetailsProps {
  adapter: Adapter | null;
  onClose: () => void;
  onEditAdapter: (adapter: Adapter) => void;
}

function AdapterDetails({ adapter, onClose, onEditAdapter }: AdapterDetailsProps) {
  if (!adapter) return null;
  const subtitle = getAdapterSubtitle(adapter);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <Badge
              className="max-w-full whitespace-normal bg-violet-100 text-left text-violet-800 hover:bg-violet-100"
              style={{ overflowWrap: "anywhere" }}
            >
              {adapter.category}
            </Badge>
            <Badge variant="secondary">{adapter.quantity} owned</Badge>
          </div>
          <DialogTitle className="pr-8 text-xl leading-7" style={{ overflowWrap: "anywhere" }}>{adapter.name}</DialogTitle>
          <DialogDescription style={{ overflowWrap: "anywhere" }}>
            {subtitle || "Adapter details and recorded physical compatibility"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <AdapterThumbnail adapter={adapter} large />
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-violet-700">
                Connects
              </p>
              <AdapterEndpointFlow adapter={adapter} />
              <p className="mt-2 text-xs leading-5 text-gray-500">
                This arrow identifies the physical endpoints only. Refer to compatibility and notes for
                pin mapping, voltage behavior, and whether any active conversion is present.
              </p>
            </div>

            {adapter.location ? (
              <p className="flex items-start gap-2 text-sm text-gray-600">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                <span style={{ overflowWrap: "anywhere" }}>{adapter.location}</span>
              </p>
            ) : null}

            {adapter.compatibility ? (
              <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-4">
                <p className="text-[11px] font-bold uppercase tracking-wider text-violet-800">Compatibility</p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-gray-700" style={{ overflowWrap: "anywhere" }}>
                  {adapter.compatibility}
                </p>
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-gray-200 p-4 text-sm text-gray-400">
                No compatibility details recorded yet.
              </p>
            )}

            {adapter.notes ? (
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Notes and limits</p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-gray-600" style={{ overflowWrap: "anywhere" }}>
                  {adapter.notes}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-4">
          {adapter.productUrl ? (
            <Button asChild type="button" variant="outline">
              <a href={adapter.productUrl} target="_blank" rel="noreferrer">
                Product page
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
          ) : null}
          <Button
            type="button"
            aria-label={`Edit ${adapter.name}, ${getAdapterConnectionLabel(adapter)}`}
            onClick={() => {
              onClose();
              onEditAdapter(adapter);
            }}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit adapter
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function AdaptersView({ onAddAdapter, onEditAdapter }: AdaptersViewProps) {
  const locationSearch = useSearch();
  const requestedSearch = useMemo(
    () => new URLSearchParams(locationSearch).get("search")?.trim() ?? "",
    [locationSearch],
  );
  const [searchQuery, setSearchQuery] = useState(requestedSearch);
  const [selectedAdapter, setSelectedAdapter] = useState<Adapter | null>(null);
  const [adapterPendingDeletion, setAdapterPendingDeletion] = useState<Adapter | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: adapters = [],
    isLoading,
    isError,
  } = useQuery<Adapter[]>({ queryKey: ["/api/adapters"] });

  useEffect(() => {
    setSearchQuery(requestedSearch);
  }, [requestedSearch]);

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleAdapters = useMemo(() => {
    const matchingAdapters = normalizedQuery
      ? adapters.filter((adapter) => matchesSearch(adapter, normalizedQuery))
      : [...adapters];
    return matchingAdapters.sort((left, right) =>
      left.category.localeCompare(right.category)
      || (left.endpointA ?? left.name).localeCompare(right.endpointA ?? right.name)
    );
  }, [adapters, normalizedQuery]);

  const totalUnits = useMemo(
    () => visibleAdapters.reduce((total, adapter) => total + adapter.quantity, 0),
    [visibleAdapters],
  );

  const deleteMutation = useMutation({
    mutationFn: async (adapter: Adapter) => {
      await apiRequest("DELETE", `/api/adapters/${adapter.id}`);
      return adapter;
    },
    onSuccess: (adapter) => {
      setAdapterPendingDeletion(null);
      if (selectedAdapter?.id === adapter.id) setSelectedAdapter(null);
      toast({ title: `${adapter.name} deleted` });
    },
    onError: (error) => {
      toast({
        title: "Could not delete adapter",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        predicate: query => {
          const root = query.queryKey[0];
          return typeof root === "string" && root.startsWith("/api/adapters");
        },
      });
    },
  });

  const hasAdapters = adapters.length > 0;
  const hasMatches = visibleAdapters.length > 0;

  return (
    <section className="case-library" aria-labelledby="adapters-title">
      <div className="case-library-heading-row">
        <div>
          <p className="case-library-eyebrow">Interconnect resources</p>
          <h1 id="adapters-title" className="case-library-title">Adapters</h1>
          <p className="case-library-description">
            Find adapters by the physical package or connector on each side. Endpoint arrows do not imply signal direction or active conversion.
          </p>
        </div>
        <Button className="case-library-add-button" onClick={onAddAdapter}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add adapter
        </Button>
      </div>

      {hasAdapters ? (
        <div className="case-library-toolbar">
          <label className="case-library-search">
            <span className="sr-only">Search adapters</span>
            <Search className="case-library-search-icon h-4 w-4" aria-hidden="true" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search endpoint, connector, package, model, compatibility, or location"
              className="case-library-search-input"
            />
          </label>
          <p className="case-library-count" aria-live="polite">
            {visibleAdapters.length} {visibleAdapters.length === 1 ? "adapter" : "adapters"}
            {totalUnits !== visibleAdapters.length ? ` / ${totalUnits} total units` : ""}
          </p>
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3" aria-label="Loading adapters">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-64 animate-pulse rounded-2xl border border-gray-200 bg-white" />
          ))}
        </div>
      ) : isError ? (
        <div className="case-library-empty">
          <div className="case-library-empty-icon" aria-hidden="true"><Cable className="h-7 w-7" /></div>
          <h2>Adapters could not be loaded</h2>
          <p>Check that the catalog server is running, then refresh this page.</p>
        </div>
      ) : hasMatches ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {visibleAdapters.map((adapter) => {
            const subtitle = getAdapterSubtitle(adapter);
            const isSearchMatch = Boolean(normalizedQuery && matchesSearch(adapter, normalizedQuery));
            return (
              <article
                key={adapter.id}
                className={`flex min-h-64 min-w-0 flex-col overflow-hidden rounded-2xl bg-white transition hover:-translate-y-0.5 hover:shadow-md ${
                  isSearchMatch
                    ? "border border-violet-300 shadow-md ring-2 ring-violet-100"
                    : "border border-gray-200 shadow-sm hover:border-violet-200"
                }`}
              >
                <button
                  type="button"
                  className="flex w-full min-w-0 flex-1 flex-col overflow-hidden p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
                  onClick={() => setSelectedAdapter(adapter)}
                  aria-label={`View details for ${adapter.name}, ${getAdapterConnectionLabel(adapter)}`}
                  title={`${adapter.name}: ${getAdapterConnectionLabel(adapter)}`}
                >
                  <div className="flex w-full items-start gap-3">
                    <AdapterThumbnail key={adapter.imageUrl ?? "empty"} adapter={adapter} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-violet-700" style={{ overflowWrap: "anywhere" }}>
                          {adapter.category}
                        </p>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-700">
                          <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
                          {adapter.quantity}
                        </span>
                      </div>
                      <h2
                        className="mt-1 max-h-10 overflow-hidden text-base font-semibold leading-5 text-gray-900"
                        style={{
                          display: "-webkit-box",
                          WebkitBoxOrient: "vertical",
                          WebkitLineClamp: 2,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {adapter.name}
                      </h2>
                      {subtitle ? (
                        <p
                          className="mt-1 max-h-4 overflow-hidden text-xs leading-4 text-gray-500"
                          style={{
                            display: "-webkit-box",
                            WebkitBoxOrient: "vertical",
                            WebkitLineClamp: 1,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {subtitle}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {isSearchMatch ? (
                    <span className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-800">
                      <Search className="h-3.5 w-3.5" aria-hidden="true" /> Search match
                    </span>
                  ) : null}

                  <p className="mt-4 text-[10px] font-bold uppercase tracking-wider text-gray-500">Connects</p>
                  <AdapterEndpointFlow adapter={adapter} className="mt-2 w-full" />
                  <span className="mt-auto inline-flex items-center gap-1.5 pt-4 text-xs font-semibold text-violet-700">
                    <Info className="h-3.5 w-3.5" aria-hidden="true" />
                    View compatibility and limits
                  </span>
                </button>

                <div className="flex items-center justify-end gap-1 border-t border-gray-100 bg-gray-50/70 px-3 py-2">
                  {adapter.productUrl ? (
                    <Button asChild type="button" variant="ghost" size="sm">
                      <a href={adapter.productUrl} target="_blank" rel="noreferrer" aria-label={`Open product page for ${adapter.name}`}>
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only sm:not-sr-only">Product</span>
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Edit ${adapter.name}, ${getAdapterConnectionLabel(adapter)}`}
                    onClick={() => onEditAdapter(adapter)}
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only sm:not-sr-only">Edit</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:bg-red-50 hover:text-red-700"
                    onClick={() => setAdapterPendingDeletion(adapter)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only">Delete {adapter.name}</span>
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="case-library-empty">
          <div className="case-library-empty-icon" aria-hidden="true">
            {hasAdapters ? <Search className="h-7 w-7" /> : <Cable className="h-7 w-7" />}
          </div>
          <h2>{hasAdapters ? "No matching adapters" : "Your adapter catalog is empty"}</h2>
          <p>
            {hasAdapters
              ? `Nothing matches "${searchQuery.trim()}". Try an endpoint, connector, package, model, or location.`
              : "Add adapters and breakouts so integration and debugging guidance can account for what is available."}
          </p>
          {hasAdapters ? (
            <Button variant="outline" onClick={() => setSearchQuery("")}>Clear search</Button>
          ) : (
            <Button onClick={onAddAdapter}><Plus className="h-4 w-4" aria-hidden="true" />Add your first adapter</Button>
          )}
        </div>
      )}

      <AdapterDetails
        adapter={selectedAdapter}
        onClose={() => setSelectedAdapter(null)}
        onEditAdapter={onEditAdapter}
      />

      <AlertDialog
        open={!!adapterPendingDeletion}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleteMutation.isPending) setAdapterPendingDeletion(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete adapter?</AlertDialogTitle>
            <AlertDialogDescription style={{ overflowWrap: "anywhere" }}>
              {adapterPendingDeletion?.name} will no longer appear in the adapter catalog or compatibility searches.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600"
              onClick={(event) => {
                event.preventDefault();
                if (adapterPendingDeletion) deleteMutation.mutate(adapterPendingDeletion);
              }}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete adapter"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
