import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch, Link } from "wouter";
import { ArrowLeft, BookOpen, Box, Cable, MapPin, Grid3X3, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import CaseThumbnail from "@/components/case-thumbnail";
import AdapterEndpointFlow from "@/components/adapter-endpoint-flow";
import { formatCompartmentCoordinates } from "@/lib/compartment-labels";
import type {
  Component,
  Case,
  CaseWithCompartments,
  ComponentBookSearchResult,
  Adapter,
} from "@shared/schema";

const categoryById: Record<number, string> = {
  1: "resistor",
  2: "capacitor",
  3: "ic",
  4: "diode",
  5: "transistor",
  6: "inductor",
  7: "crystal",
  8: "connector",
  9: "led",
  10: "switch",
  11: "sensor",
  12: "other",
};

function buildCase3dHref(case_: CaseWithCompartments, component: Component, query: string) {
  const compartment = case_.compartments.find(candidate => candidate.id === component.compartmentId);
  const params = new URLSearchParams({
    case: String(case_.id),
    view: "case3d",
    component: String(component.id),
  });

  if (query.trim()) params.set("search", query.trim());
  if (compartment?.layer === "bottom") params.set("layer", "bottom");

  return `/?${params.toString()}`;
}

export default function SearchResults() {
  const [, setLocation] = useLocation();
  const locationSearch = useSearch();
  const searchParams = new URLSearchParams(locationSearch);
  const query = searchParams.get('q') || '';
  const [viewMode, setViewMode] = useState<'thumbnail' | 'list'>('thumbnail');

  const {
    data: components = [],
    isLoading: componentsLoading,
    isError: componentsError,
  } = useQuery<Component[]>({
    queryKey: ["/api/components/search", query],
    queryFn: async () => {
      const response = await fetch(`/api/components/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error("Failed to search components");
      return response.json();
    },
    enabled: !!query
  });

  const {
    data: casesData = [],
    isLoading: casesLoading,
    isError: casesError,
  } = useQuery<Case[]>({
    queryKey: ["/api/cases"],
  });

  const {
    data: bookItems = [],
    isLoading: bookItemsLoading,
    isError: bookItemsError,
  } = useQuery<ComponentBookSearchResult[]>({
    queryKey: ["/api/component-book-items/search", query],
    queryFn: async () => {
      const response = await fetch(`/api/component-book-items/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error("Failed to search component books");
      return response.json();
    },
    enabled: !!query,
  });

  const {
    data: adapters = [],
    isLoading: adaptersLoading,
    isError: adaptersError,
  } = useQuery<Adapter[]>({
    queryKey: ["/api/adapters/search", query],
    queryFn: async () => {
      const response = await fetch(`/api/adapters/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error("Failed to search adapters");
      return response.json();
    },
    enabled: !!query,
  });

  // Fetch detailed case data with compartments
  const {
    data: casesWithCompartments = [],
    isLoading: caseDetailsLoading,
    isError: caseDetailsError,
  } = useQuery<CaseWithCompartments[]>({
    queryKey: ["/api/cases/detailed", casesData.map((c) => c.id)],
    queryFn: async () => {
      if (!casesData.length) return [];
      const promises = casesData.map(async (case_) => {
        const response = await fetch(`/api/cases/${case_.id}`);
        if (!response.ok) throw new Error(`Failed to load ${case_.name}`);
        return response.json();
      });
      return Promise.all(promises);
    },
    enabled: casesData.length > 0
  });

  // Group components by case
  const componentsByCase = components.reduce((acc: Record<number, Component[]>, component: Component) => {
    const case_ = casesWithCompartments.find(c =>
      c.compartments.some(comp => comp.id === component.compartmentId)
    );
    if (case_) {
      if (!acc[case_.id]) acc[case_.id] = [];
      acc[case_.id].push(component);
    }
    return acc;
  }, {});

  const bookItemsByBook = bookItems.reduce((acc: Record<number, ComponentBookSearchResult[]>, item) => {
    if (!acc[item.book.id]) acc[item.book.id] = [];
    acc[item.book.id].push(item);
    return acc;
  }, {});

  const getComponentCase = (compartmentId: number) => {
    return casesWithCompartments.find(case_ =>
      case_.compartments?.some((comp: any) => comp.id === compartmentId)
    ) || null;
  };

  const getCompartmentPosition = (compartmentId: number) => {
    for (const case_ of casesWithCompartments) {
      const compartment = case_.compartments?.find((comp) => comp.id === compartmentId);
      if (compartment) {
        return {
          position: compartment.position,
          layer: compartment.layer,
          coordinates: formatCompartmentCoordinates(compartment),
        };
      }
    }
    return null;
  };

  const locationsLoading = components.length > 0 && casesData.length > 0 && caseDetailsLoading;

  if (componentsLoading || casesLoading || locationsLoading || bookItemsLoading || adaptersLoading) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center space-x-4 mb-6">
            <Link href="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Dashboard
              </Button>
            </Link>
            <h1 className="text-2xl font-bold">Searching...</h1>
          </div>
        </div>
      </div>
    );
  }

  if (componentsError || casesError || caseDetailsError || bookItemsError || adaptersError) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="mx-auto max-w-4xl rounded-lg border border-red-200 bg-white p-8 text-center">
          <h1 className="text-xl font-semibold text-gray-900">Search results could not be loaded</h1>
          <p className="mt-2 text-sm text-gray-600">
            One or more catalog searches failed, so no partial results are being shown.
          </p>
          <Link href="/">
            <Button className="mt-5" variant="outline">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-4">
            <Link href="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Dashboard
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold">Search Results for "{query}"</h1>
              <p className="text-gray-600">
                Found {components.length} loose {components.length === 1 ? "component" : "components"}, {bookItems.length} book {bookItems.length === 1 ? "entry" : "entries"}, and {adapters.length} {adapters.length === 1 ? "adapter" : "adapters"}
              </p>
            </div>
          </div>

          {components.length > 0 && (
            <div className="flex items-center space-x-2">
              <Button
                variant={viewMode === 'thumbnail' ? 'default' : 'outline'}
                size="sm"
                aria-pressed={viewMode === 'thumbnail'}
                onClick={() => setViewMode('thumbnail')}
              >
                <Grid3X3 className="h-4 w-4 mr-2" />
                Thumbnail
              </Button>
              <Button
                variant={viewMode === 'list' ? 'default' : 'outline'}
                size="sm"
                aria-pressed={viewMode === 'list'}
                onClick={() => setViewMode('list')}
              >
                <List className="h-4 w-4 mr-2" />
                List
              </Button>
            </div>
          )}
        </div>

        {adapters.length > 0 ? (
          <section className="mb-7" aria-labelledby="adapter-search-results-title">
            <div className="mb-3 flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-cyan-100 text-cyan-700">
                <Cable className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h2 id="adapter-search-results-title" className="text-lg font-bold text-gray-900">
                  Available adapters
                </h2>
                <p className="text-sm text-gray-600">
                  Owned sockets, breakouts, and interconnects that may support this task.
                </p>
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {adapters.map((adapter) => (
                <article key={adapter.id} className="min-w-0 rounded-xl border-2 border-cyan-200 bg-cyan-50/70 p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-bold uppercase tracking-wider text-cyan-700" style={{ overflowWrap: "anywhere" }}>{adapter.category}</p>
                      <h3 className="mt-1 text-lg font-bold text-gray-900" style={{ overflowWrap: "anywhere" }}>{adapter.name}</h3>
                      {[adapter.manufacturer, adapter.modelNumber].filter(Boolean).length > 0 ? (
                        <p className="mt-1 text-sm text-gray-600" style={{ overflowWrap: "anywhere" }}>
                          {[adapter.manufacturer, adapter.modelNumber].filter(Boolean).join(" ")}
                        </p>
                      ) : null}
                    </div>
                    <Badge variant="secondary">{adapter.quantity} owned</Badge>
                  </div>
                  <div className="mt-4">
                    <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-cyan-800">Connects</p>
                    <AdapterEndpointFlow adapter={adapter} />
                    <p className="mt-2 text-xs text-gray-500">Physical endpoints only; the arrow does not imply signal direction or conversion.</p>
                  </div>
                  {adapter.compatibility ? (
                    <p className="mt-4 whitespace-pre-wrap text-sm leading-5 text-gray-700" style={{ overflowWrap: "anywhere" }}>{adapter.compatibility}</p>
                  ) : null}
                  {adapter.location ? (
                    <p className="mt-3 flex items-center gap-1.5 text-sm text-gray-600">
                      <MapPin className="h-4 w-4" aria-hidden="true" />
                      <span style={{ overflowWrap: "anywhere" }}>{adapter.location}</span>
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-4 border-cyan-300 bg-white hover:bg-cyan-100"
                    aria-label={`View ${adapter.name}: ${adapter.endpointA || "endpoint A not recorded"} to ${adapter.endpointB || "endpoint B not recorded"}`}
                    onClick={() => setLocation(`/adapters?search=${encodeURIComponent(query)}`)}
                  >
                    <Cable className="mr-2 h-4 w-4" aria-hidden="true" />
                    View adapter catalog
                  </Button>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {bookItems.length > 0 ? (
          <section className="mb-7" aria-labelledby="book-search-results-title">
            <div className="mb-3 flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-amber-100 text-amber-700">
                <BookOpen className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h2 id="book-search-results-title" className="text-lg font-bold text-gray-900">
                  Also included in component books
                </h2>
                <p className="text-sm text-gray-600">
                  These are book contents, separate from individually stored components.
                </p>
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {Object.values(bookItemsByBook).map((matches) => {
                const book = matches[0].book;
                const packageSizes = book.packageSize
                  ? [book.packageSize]
                  : Array.from(new Set(matches.map((item) => item.packageSize).filter(Boolean))) as string[];
                return (
                  <div key={book.id} className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider text-amber-700">Found in this book</p>
                        <h3 className="mt-1 text-lg font-bold text-gray-900">{book.name}</h3>
                        {book.manufacturer ? <p className="mt-1 text-sm text-gray-600">{book.manufacturer}</p> : null}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {packageSizes.map((size) => (
                          <span key={size} className="rounded-md bg-gray-900 px-2.5 py-1 font-mono text-xs font-bold text-white">
                            {size}
                          </span>
                        ))}
                      </div>
                    </div>
                    <ul className="mt-4 space-y-2">
                      {matches.slice(0, 8).map((item) => (
                        <li key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm">
                          <span className="font-semibold text-gray-900">{item.name}</span>
                          <span className="shrink-0 text-gray-600">{item.value || item.partNumber || "Included"}</span>
                        </li>
                      ))}
                    </ul>
                    {matches.length > 8 ? (
                      <p className="mt-2 text-xs font-medium text-amber-800">+{matches.length - 8} more matching entries</p>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-4 border-amber-300 bg-white hover:bg-amber-100"
                      onClick={() => setLocation(`/books?search=${encodeURIComponent(query)}`)}
                    >
                      <BookOpen className="mr-2 h-4 w-4" aria-hidden="true" />
                      View book contents
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {components.length === 0 && bookItems.length === 0 && adapters.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
            <p className="text-gray-500">No components found matching your search.</p>
          </div>
        ) : components.length === 0 ? null : viewMode === 'thumbnail' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Object.entries(componentsByCase).map(([caseId, caseComponents]) => {
              const case_ = casesWithCompartments.find(c => c.id === parseInt(caseId));
              if (!case_) return null;

              return (
                <CaseThumbnail
                  key={caseId}
                  case_={case_}
                  matchingComponents={caseComponents}
                  onClick={() => setLocation(buildCase3dHref(case_, caseComponents[0], query))}
                />
              );
            })}
          </div>
        ) : (
          <div className="grid gap-4">
            {components.map((component: Component) => {
              const case_ = getComponentCase(component.compartmentId);
              const compartmentInfo = getCompartmentPosition(component.compartmentId);

              return (
                <div key={component.id} className="bg-white rounded-lg border border-gray-200 p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-3">
                        <h3 className="text-lg font-semibold text-gray-900">
                          {component.name}
                        </h3>
                        <Badge variant="secondary">{categoryById[component.categoryId] || "other"}</Badge>
                      </div>

                      <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <span className="text-gray-500">Package:</span>
                          <p className="font-medium">{component.packageSize || 'N/A'}</p>
                        </div>
                        <div>
                          <span className="text-gray-500">Quantity:</span>
                          <p className={`font-medium ${
                            component.quantity <= (component.minQuantity || 5) / 2 ? 'text-red-600' :
                            component.quantity <= (component.minQuantity || 5) ? 'text-orange-600' :
                            'text-green-600'
                          }`}>
                            {component.quantity}
                          </p>
                        </div>
                        <div>
                          <span className="text-gray-500">Min Stock:</span>
                          <p className="font-medium">{component.minQuantity}</p>
                        </div>
                        <div>
                          <span className="text-gray-500">Notes:</span>
                          <p className="font-medium">{component.notes || 'None'}</p>
                        </div>
                      </div>
                    </div>

                    {case_ && compartmentInfo && (
                      <div className="ml-6 text-right">
                        <div className="flex items-center text-gray-600 mb-2">
                          <MapPin className="h-4 w-4 mr-1" />
                          <span className="text-sm">Location</span>
                        </div>
                        <div className="bg-gray-50 rounded-lg p-3 min-w-[120px]">
                          <p className="font-medium text-gray-900">{case_.name}</p>
                          <p className="text-sm text-gray-600">
                            {compartmentInfo.position} ({compartmentInfo.layer})
                          </p>
                          <p className="text-xs text-gray-500">{compartmentInfo.coordinates}</p>
                          <p className="text-xs text-gray-500 mt-1">{case_.model}</p>
                          <Button
                            type="button"
                            size="sm"
                            className="mt-3 w-full gap-2"
                            onClick={() => setLocation(buildCase3dHref(case_, component, query))}
                          >
                            <Box className="h-4 w-4" aria-hidden="true" />
                            Show in 3D
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
