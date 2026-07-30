import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Loader2,
  Minus,
  Plus,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCompartmentCoordinates } from "@/lib/compartment-labels";
import { COMPONENT_CATEGORIES } from "@/lib/constants";
import { apiRequest } from "@/lib/queryClient";
import { UNSORTED_CASE_MODEL } from "@shared/case-layouts";
import type { Case, CaseWithCompartments, Compartment, Component } from "@shared/schema";

const CASES_QUERY_KEY = "/api/cases";
const QUANTITY_CASES_QUERY_KEY = "/api/quantity-editor/cases";

type SaveState = "pending" | "saving" | "saved" | "error";
type ComponentCategory = (typeof COMPONENT_CATEGORIES)[number];

interface QuantityEntry {
  case_: CaseWithCompartments;
  compartment: Compartment;
  component: Component;
  category: ComponentCategory;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });

  if (!response.ok) {
    const message = (await response.text()) || response.statusText;
    throw new Error(message);
  }

  return response.json();
}

function sortCases(left: Case, right: Case) {
  if (left.model === UNSORTED_CASE_MODEL) return -1;
  if (right.model === UNSORTED_CASE_MODEL) return 1;
  return left.sortOrder - right.sortOrder || left.id - right.id;
}

function getLayerOrder(layer: string) {
  if (layer === "top") return 0;
  if (layer === "bottom") return 1;
  return 2;
}

function sortCompartments(left: Compartment, right: Compartment) {
  return getLayerOrder(left.layer) - getLayerOrder(right.layer) ||
    left.row - right.row ||
    left.col - right.col ||
    left.id - right.id;
}

function getCategory(component: Component) {
  return COMPONENT_CATEGORIES[component.categoryId - 1] || COMPONENT_CATEGORIES[COMPONENT_CATEGORIES.length - 1];
}

function getQuantityEntries(cases: CaseWithCompartments[]) {
  return cases.flatMap((case_) =>
    [...case_.compartments]
      .sort(sortCompartments)
      .filter((compartment): compartment is Compartment & { component: Component } => Boolean(compartment.component))
      .map((compartment) => ({
        case_,
        compartment,
        component: compartment.component,
        category: getCategory(compartment.component),
      })),
  );
}

function getLocationLabel(compartment: Compartment) {
  return `${compartment.layer} ${compartment.position}`;
}

function matchesQuantitySearch(entry: QuantityEntry, query: string) {
  if (!query) return true;

  const normalizedQuery = query.toLowerCase();
  return (
    entry.case_.name.toLowerCase().includes(normalizedQuery) ||
    entry.component.name.toLowerCase().includes(normalizedQuery) ||
    entry.category.label.toLowerCase().includes(normalizedQuery) ||
    entry.category.value.toLowerCase().includes(normalizedQuery) ||
    (entry.component.packageSize?.toLowerCase().includes(normalizedQuery) ?? false) ||
    (entry.component.notes?.toLowerCase().includes(normalizedQuery) ?? false) ||
    entry.compartment.position.toLowerCase().includes(normalizedQuery) ||
    entry.compartment.layer.toLowerCase().includes(normalizedQuery)
  );
}

function getStockState(quantity: number, minQuantity: number | null = 5) {
  const minimum = minQuantity ?? 5;
  if (quantity === 0) return { label: "Empty", className: "border-gray-300 bg-gray-50 text-gray-600" };
  if (quantity <= minimum / 2) return { label: "Critical", className: "border-red-200 bg-red-50 text-red-700" };
  if (quantity <= minimum) return { label: "Low", className: "border-orange-200 bg-orange-50 text-orange-700" };
  return { label: "Good", className: "border-green-200 bg-green-50 text-green-700" };
}

function getQuantityFromDraft(value: string | undefined, fallback: number) {
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function SaveStatus({ state }: { state?: SaveState }) {
  if (!state) {
    return <span className="inline-block w-20" aria-label="No save changes" />;
  }

  if (state === "pending") {
    return (
      <span className="inline-flex w-20 items-center gap-1 text-xs font-medium text-gray-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        Queued
      </span>
    );
  }

  if (state === "saving") {
    return (
      <span className="inline-flex w-20 items-center gap-1 text-xs font-medium text-blue-700">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving
      </span>
    );
  }

  if (state === "error") {
    return (
      <span className="inline-flex w-20 items-center gap-1 text-xs font-medium text-red-700">
        <AlertCircle className="h-3 w-3" />
        Error
      </span>
    );
  }

  return (
    <span className="inline-flex w-20 items-center gap-1 text-xs font-medium text-green-700">
      <CheckCircle2 className="h-3 w-3" />
      Saved
    </span>
  );
}

export default function QuantityEditor() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const saveTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const clearStatusTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const latestQuantityById = useRef<Record<number, number>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [draftQuantities, setDraftQuantities] = useState<Record<number, string>>({});
  const [saveStateById, setSaveStateById] = useState<Record<number, SaveState>>({});

  const { data: cases = [], isLoading: isLoadingCases, isError: casesFailed } = useQuery<Case[]>({
    queryKey: [CASES_QUERY_KEY],
  });

  const orderedCases = useMemo(() => [...cases].sort(sortCases), [cases]);
  const caseIds = useMemo(() => orderedCases.map((case_) => case_.id), [orderedCases]);

  const {
    data: caseDetails = [],
    isLoading: isLoadingDetails,
    isError: detailsFailed,
  } = useQuery<CaseWithCompartments[]>({
    queryKey: [QUANTITY_CASES_QUERY_KEY, caseIds],
    queryFn: async () => Promise.all(
      orderedCases.map((case_) => fetchJson<CaseWithCompartments>(`/api/cases/${case_.id}`)),
    ),
    enabled: orderedCases.length > 0,
  });

  const allEntries = useMemo(() => getQuantityEntries(caseDetails), [caseDetails]);
  const visibleEntries = useMemo(
    () => allEntries.filter((entry) => matchesQuantitySearch(entry, searchQuery.trim())),
    [allEntries, searchQuery],
  );
  const totalQuantity = useMemo(
    () => allEntries.reduce((sum, entry) => sum + getQuantityFromDraft(draftQuantities[entry.component.id], entry.component.quantity), 0),
    [allEntries, draftQuantities],
  );

  const updateQuantityMutation = useMutation({
    mutationFn: async ({ componentId, quantity }: { componentId: number; quantity: number }) => {
      const response = await apiRequest("PATCH", `/api/components/${componentId}`, { quantity });
      return response.json() as Promise<Component>;
    },
    onMutate: ({ componentId }) => {
      setSaveStateById((current) => ({ ...current, [componentId]: "saving" }));
    },
    onSuccess: (updatedComponent, variables) => {
      queryClient.setQueryData<CaseWithCompartments[]>(
        [QUANTITY_CASES_QUERY_KEY, caseIds],
        (currentCases) => currentCases?.map((case_) => ({
          ...case_,
          compartments: case_.compartments.map((compartment) => (
            compartment.component?.id === updatedComponent.id
              ? { ...compartment, component: { ...compartment.component, quantity: updatedComponent.quantity } }
              : compartment
          )),
        })),
      );
      queryClient.invalidateQueries({ queryKey: [CASES_QUERY_KEY] });

      if (latestQuantityById.current[variables.componentId] !== variables.quantity) {
        return;
      }

      setDraftQuantities((current) => ({
        ...current,
        [updatedComponent.id]: String(updatedComponent.quantity),
      }));
      setSaveStateById((current) => ({ ...current, [updatedComponent.id]: "saved" }));

      if (clearStatusTimers.current[updatedComponent.id]) {
        clearTimeout(clearStatusTimers.current[updatedComponent.id]);
      }

      clearStatusTimers.current[updatedComponent.id] = setTimeout(() => {
        setSaveStateById((current) => {
          if (current[updatedComponent.id] !== "saved") return current;

          const next = { ...current };
          delete next[updatedComponent.id];
          return next;
        });
        delete clearStatusTimers.current[updatedComponent.id];
      }, 1500);
    },
    onError: (_error, variables) => {
      setSaveStateById((current) => ({ ...current, [variables.componentId]: "error" }));
    },
  });

  useEffect(() => {
    setDraftQuantities((current) => {
      const next: Record<number, string> = {};

      for (const entry of allEntries) {
        next[entry.component.id] = current[entry.component.id] ?? String(entry.component.quantity);
      }

      return next;
    });
  }, [allEntries]);

  useEffect(() => {
    return () => {
      Object.values(saveTimers.current).forEach((timer) => clearTimeout(timer));
      Object.values(clearStatusTimers.current).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  const clearSaveTimer = (componentId: number) => {
    if (!saveTimers.current[componentId]) return;

    clearTimeout(saveTimers.current[componentId]);
    delete saveTimers.current[componentId];
  };

  const scheduleQuantitySave = (component: Component, quantity: number) => {
    clearSaveTimer(component.id);
    latestQuantityById.current[component.id] = quantity;

    if (quantity === component.quantity) {
      setSaveStateById((current) => {
        const next = { ...current };
        delete next[component.id];
        return next;
      });
      return;
    }

    setSaveStateById((current) => ({ ...current, [component.id]: "pending" }));
    saveTimers.current[component.id] = setTimeout(() => {
      delete saveTimers.current[component.id];
      updateQuantityMutation.mutate({ componentId: component.id, quantity });
    }, 500);
  };

  const updateDraftQuantity = (component: Component, rawValue: string) => {
    const sanitizedValue = rawValue.replace(/[^\d]/g, "");
    setDraftQuantities((current) => ({ ...current, [component.id]: sanitizedValue }));

    if (sanitizedValue === "") {
      clearSaveTimer(component.id);
      return;
    }

    scheduleQuantitySave(component, Number(sanitizedValue));
  };

  const normalizeBlankQuantity = (component: Component) => {
    if (draftQuantities[component.id] !== "") return;

    setDraftQuantities((current) => ({ ...current, [component.id]: "0" }));
    scheduleQuantitySave(component, 0);
  };

  const stepQuantity = (component: Component, delta: number) => {
    const currentQuantity = getQuantityFromDraft(draftQuantities[component.id], component.quantity);
    const nextQuantity = Math.max(0, currentQuantity + delta);

    setDraftQuantities((current) => ({ ...current, [component.id]: String(nextQuantity) }));
    scheduleQuantitySave(component, nextQuantity);
  };

  const isLoading = isLoadingCases || (orderedCases.length > 0 && isLoadingDetails);
  const hasError = casesFailed || detailsFailed;
  const pendingCount = Object.values(saveStateById).filter((state) => state === "pending" || state === "saving").length;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gray-50">
      <header className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/")}
              title="Back to dashboard"
              aria-label="Back to dashboard"
              className="h-9 w-9 shrink-0 p-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white">
              <ClipboardList className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold text-gray-900">Quantity Editor</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500">
                <span>{allEntries.length} items</span>
                <span>{totalQuantity} total quantity</span>
                {pendingCount > 0 && <span>{pendingCount} saving</span>}
              </div>
            </div>
          </div>

          <div className="relative w-full max-w-sm">
            <Input
              type="text"
              placeholder="Search items..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="pl-10"
            />
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-gray-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading
          </div>
        ) : hasError ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-6 text-sm text-red-700">
            Quantity data could not be loaded.
          </div>
        ) : allEntries.length === 0 ? (
          <div className="rounded-md border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
            No components found.
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="rounded-md border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
            No matching components.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
            <div className="overflow-x-auto">
              <Table className="min-w-[940px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-52">Case</TableHead>
                    <TableHead className="w-36">Location</TableHead>
                    <TableHead>Component</TableHead>
                    <TableHead className="w-40">Category</TableHead>
                    <TableHead className="w-28">Package</TableHead>
                    <TableHead className="w-40 text-right">Quantity</TableHead>
                    <TableHead className="w-28 text-right">Minimum</TableHead>
                    <TableHead className="w-28">Stock</TableHead>
                    <TableHead className="w-24">Save</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleEntries.map((entry) => {
                    const draftQuantity = draftQuantities[entry.component.id] ?? String(entry.component.quantity);
                    const displayedQuantity = getQuantityFromDraft(draftQuantity, entry.component.quantity);
                    const stockState = getStockState(displayedQuantity, entry.component.minQuantity);

                    return (
                      <TableRow key={entry.component.id}>
                        <TableCell>
                          <div className="font-medium text-gray-900">{entry.case_.name}</div>
                          <div className="text-xs text-gray-500">{entry.case_.model}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-xs text-gray-900">{getLocationLabel(entry.compartment)}</div>
                          <div className="text-xs text-gray-500">{formatCompartmentCoordinates(entry.compartment)}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-gray-900">{entry.component.name}</div>
                          {entry.component.notes && (
                            <div className="mt-1 line-clamp-1 text-xs text-gray-500">{entry.component.notes}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: entry.category.color }}
                            />
                            <span>{entry.category.label}</span>
                          </span>
                        </TableCell>
                        <TableCell>{entry.component.packageSize || "None"}</TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => stepQuantity(entry.component, -1)}
                              disabled={displayedQuantity === 0}
                              title="Decrease quantity"
                              aria-label={`Decrease ${entry.component.name} quantity`}
                              className="h-9 w-9 p-0"
                            >
                              <Minus className="h-4 w-4" />
                            </Button>
                            <Input
                              type="text"
                              inputMode="numeric"
                              value={draftQuantity}
                              onChange={(event) => updateDraftQuantity(entry.component, event.target.value)}
                              onBlur={() => normalizeBlankQuantity(entry.component)}
                              onFocus={(event) => event.currentTarget.select()}
                              aria-label={`${entry.component.name} quantity`}
                              className="h-9 w-20 text-right font-mono"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => stepQuantity(entry.component, 1)}
                              title="Increase quantity"
                              aria-label={`Increase ${entry.component.name} quantity`}
                              className="h-9 w-9 p-0"
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{entry.component.minQuantity ?? 5}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={stockState.className}>
                            {stockState.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <SaveStatus state={saveStateById[entry.component.id]} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
