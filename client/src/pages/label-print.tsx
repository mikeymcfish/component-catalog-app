import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  Loader2,
  Printer,
  Search,
  Tags,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COMPONENT_CATEGORIES } from "@/lib/constants";
import { getCaseLayerLayouts, UNSORTED_CASE_MODEL } from "@shared/case-layouts";
import type { Case, CaseWithCompartments, Compartment, Component } from "@shared/schema";
import resistorIcon from "../assets/icons/resistor.svg";
import capacitorIcon from "../assets/icons/capacitor.svg";
import inductorIcon from "../assets/icons/inductor.svg";
import transistorIcon from "../assets/icons/transistor.svg";
import diodeIcon from "../assets/icons/diode.svg";
import icIcon from "../assets/icons/ic.svg";
import crystalIcon from "../assets/icons/crystal.svg";
import connectorIcon from "../assets/icons/connector.svg";
import switchIcon from "../assets/icons/switch.svg";
import ledIcon from "../assets/icons/led.svg";
import sensorIcon from "../assets/icons/sensor.svg";
import otherIcon from "../assets/icons/other.svg";

const CASES_QUERY_KEY = "/api/cases";
const LABEL_CASES_QUERY_KEY = "/api/labels/cases";
const PHYSICAL_LABELS_PER_SHEET = 160;

type LabelSize = "full" | "wide" | "tall" | "small";
type LabelPackSize = Exclude<LabelSize, "full">;
type LabelFilter = "all" | LabelSize;
type CutGuideMode = "center" | "full" | "none";
type PrintContentMode = "labels" | "placement";

interface LabelEntry {
  case_: CaseWithCompartments;
  compartment: Compartment;
  component: Component;
  category: (typeof COMPONENT_CATEGORIES)[number];
  size: LabelSize;
}

type LabelSlot =
  | { kind: "blank"; id: string }
  | { kind: "full"; id: string; entry: LabelEntry }
  | { kind: LabelPackSize; id: string; entries: LabelEntry[] };

const categoryIconByValue: Record<string, string> = {
  resistor: resistorIcon,
  capacitor: capacitorIcon,
  inductor: inductorIcon,
  transistor: transistorIcon,
  diode: diodeIcon,
  ic: icIcon,
  crystal: crystalIcon,
  connector: connectorIcon,
  switch: switchIcon,
  led: ledIcon,
  sensor: sensorIcon,
  other: otherIcon,
};

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

function getLayerColumnCount(case_: CaseWithCompartments, compartment: Compartment) {
  const layerLayout = getCaseLayerLayouts(case_).find((layout) => layout.layer === compartment.layer);
  return layerLayout?.cols ?? case_.cols;
}

function getLabelSize(case_: CaseWithCompartments, compartment: Compartment): LabelSize {
  if (case_.model === "LAYOUT-6x4-TOP") {
    if (compartment.layer === "top") {
      return compartment.row <= 2 ? "wide" : "tall";
    }

    return "small";
  }

  if (case_.model === "LAYOUT-6x4-BOTH") {
    return "tall";
  }

  return getLayerColumnCount(case_, compartment) === 12 ? "small" : "full";
}

function getLabelEntries(cases: CaseWithCompartments[]) {
  return cases.flatMap((case_) =>
    [...case_.compartments]
      .sort(sortCompartments)
      .filter((compartment): compartment is Compartment & { component: Component } => Boolean(compartment.component))
      .map((compartment) => ({
        case_,
        compartment,
        component: compartment.component,
        category: getCategory(compartment.component),
        size: getLabelSize(case_, compartment),
      })),
  );
}

function matchesSearch(entry: LabelEntry, query: string) {
  if (!query) return true;

  const normalizedQuery = query.toLowerCase();
  return (
    entry.case_.name.toLowerCase().includes(normalizedQuery) ||
    entry.component.name.toLowerCase().includes(normalizedQuery) ||
    entry.category.label.toLowerCase().includes(normalizedQuery) ||
    entry.category.value.toLowerCase().includes(normalizedQuery) ||
    (entry.component.packageSize?.toLowerCase().includes(normalizedQuery) ?? false) ||
    entry.compartment.position.toLowerCase().includes(normalizedQuery) ||
    entry.compartment.layer.toLowerCase().includes(normalizedQuery)
  );
}

function makeLabelSlots(entries: LabelEntry[], startOffset: number) {
  const slots: LabelSlot[] = Array.from({ length: startOffset }, (_value, index) => ({
    kind: "blank",
    id: `blank-${index}`,
  }));
  let packKind: LabelPackSize | null = null;
  let packBuffer: LabelEntry[] = [];
  const packCapacity: Record<LabelPackSize, number> = {
    wide: 2,
    tall: 2,
    small: 4,
  };

  const flushPackBuffer = () => {
    if (!packKind || packBuffer.length === 0) return;

    slots.push({
      kind: packKind,
      id: `${packKind}-${packBuffer.map((entry) => entry.component.id).join("-")}`,
      entries: packBuffer,
    });
    packKind = null;
    packBuffer = [];
  };

  for (const entry of entries) {
    if (entry.size !== "full") {
      if (packKind && packKind !== entry.size) {
        flushPackBuffer();
      }

      packKind = entry.size;
      packBuffer.push(entry);
      if (packBuffer.length === packCapacity[entry.size]) {
        flushPackBuffer();
      }
      continue;
    }

    flushPackBuffer();
    slots.push({
      kind: "full",
      id: `full-${entry.component.id}`,
      entry,
    });
  }

  flushPackBuffer();
  return slots;
}

function paginateSlots(slots: LabelSlot[]) {
  const pages: LabelSlot[][] = [];

  for (let index = 0; index < slots.length; index += PHYSICAL_LABELS_PER_SHEET) {
    pages.push(slots.slice(index, index + PHYSICAL_LABELS_PER_SHEET));
  }

  return pages.length > 0 ? pages : [[]];
}

function getQueryCaseId() {
  const caseId = new URLSearchParams(window.location.search).get("caseId");
  return caseId && /^\d+$/.test(caseId) ? caseId : "all";
}

function LabelContent({ entry, size }: { entry: LabelEntry; size: LabelSize }) {
  const iconSrc = categoryIconByValue[entry.category.value] || otherIcon;
  const showSymbol = size === "full" || size === "tall";
  const showMeta = size === "full";

  return (
    <div className={`print-label-content print-label-content-${size}`}>
      {showSymbol && <img src={iconSrc} alt="" className="print-label-symbol" />}
      <div className="print-label-text">
        <div className="print-label-name">{entry.component.name}</div>
        {showMeta && (
          <div className="print-label-meta">
            {entry.component.packageSize || entry.category.label}
          </div>
        )}
      </div>
    </div>
  );
}

function getLocationCode(entry: LabelEntry) {
  const caseMatch = entry.case_.name.match(/\d+/);
  const caseCode = caseMatch ? caseMatch[0] : String(entry.case_.id);

  return `${caseCode}-${entry.compartment.position}`;
}

function PlacementContent({ entry, size }: { entry: LabelEntry; size: LabelSize }) {
  return (
    <div className={`print-label-content print-label-placement print-label-placement-${size}`}>
      {getLocationCode(entry)}
    </div>
  );
}

function getCutGuideClass(guideMode: CutGuideMode) {
  if (guideMode === "center") return "print-cut-center";
  if (guideMode === "full") return "print-cut-full";
  return "";
}

function PrintableLabelSlot({
  slot,
  guideMode,
  contentMode,
}: {
  slot: LabelSlot;
  guideMode: CutGuideMode;
  contentMode: PrintContentMode;
}) {
  const cutGuideClass = getCutGuideClass(guideMode);
  const renderContent = (entry: LabelEntry, size: LabelSize) => (
    contentMode === "placement"
      ? <PlacementContent entry={entry} size={size} />
      : <LabelContent entry={entry} size={size} />
  );

  if (slot.kind === "blank") {
    return <div className="print-label-physical print-label-blank" />;
  }

  if (slot.kind === "full") {
    return (
      <div className={`print-label-physical print-label-full ${cutGuideClass}`}>
        {renderContent(slot.entry, "full")}
      </div>
    );
  }

  return (
    <div className={`print-label-physical print-label-${slot.kind}-pack ${cutGuideClass}`}>
      {Array.from({ length: slot.kind === "small" ? 4 : 2 }, (_value, index) => {
        const entry = slot.entries[index];

        return (
          <div
            key={entry?.component.id ?? `empty-${slot.kind}-${index}`}
            className={`print-label-${slot.kind}-cell ${cutGuideClass}`}
          >
            {entry && renderContent(entry, slot.kind)}
          </div>
        );
      })}
    </div>
  );
}

export default function LabelPrint() {
  const [, setLocation] = useLocation();
  const [selectedCaseId, setSelectedCaseId] = useState(getQueryCaseId);
  const [labelFilter, setLabelFilter] = useState<LabelFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [guideMode, setGuideMode] = useState<CutGuideMode>("center");
  const [contentMode, setContentMode] = useState<PrintContentMode>("labels");
  const [startOffset, setStartOffset] = useState("0");

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
    queryKey: [LABEL_CASES_QUERY_KEY, caseIds],
    queryFn: async () => Promise.all(
      orderedCases.map((case_) => fetchJson<CaseWithCompartments>(`/api/cases/${case_.id}`)),
    ),
    enabled: orderedCases.length > 0,
  });

  useEffect(() => {
    if (selectedCaseId === "all") return;
    if (orderedCases.some((case_) => String(case_.id) === selectedCaseId)) return;

    setSelectedCaseId("all");
  }, [orderedCases, selectedCaseId]);

  const entries = useMemo(() => {
    const selectedCases = selectedCaseId === "all"
      ? caseDetails
      : caseDetails.filter((case_) => String(case_.id) === selectedCaseId);
    const normalizedSearch = searchQuery.trim();

    return getLabelEntries(selectedCases).filter((entry) => {
      if (labelFilter !== "all" && entry.size !== labelFilter) return false;
      return matchesSearch(entry, normalizedSearch);
    });
  }, [caseDetails, labelFilter, searchQuery, selectedCaseId]);

  const offsetValue = Math.max(0, Number.parseInt(startOffset, 10) || 0);
  const slots = useMemo(() => makeLabelSlots(entries, offsetValue), [entries, offsetValue]);
  const pages = useMemo(() => paginateSlots(slots), [slots]);
  const labelCounts = useMemo(() => entries.reduce(
    (counts, entry) => ({
      ...counts,
      [entry.size]: counts[entry.size] + 1,
    }),
    { full: 0, wide: 0, tall: 0, small: 0 } as Record<LabelSize, number>,
  ), [entries]);
  const isLoading = isLoadingCases || (orderedCases.length > 0 && isLoadingDetails);
  const hasError = casesFailed || detailsFailed;

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="label-print-shell min-h-screen bg-gray-50">
      <header className="no-print border-b border-gray-200 bg-white px-6 py-4">
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
              <Tags className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold text-gray-900">
                {contentMode === "placement" ? "Print Placement Sheet" : "Print Labels"}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500">
                <span>{entries.length} {contentMode === "placement" ? "placement codes" : "component labels"}</span>
                <span>{labelCounts.full} full</span>
                <span>{labelCounts.wide} wide</span>
                <span>{labelCounts.tall} tall</span>
                <span>{labelCounts.small} small</span>
                <span>{slots.length} physical labels</span>
              </div>
            </div>
          </div>

          <Button type="button" onClick={handlePrint} className="h-9">
            <Printer className="h-4 w-4" />
            Print
          </Button>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(170px,220px)_minmax(180px,240px)_minmax(150px,190px)_minmax(220px,1fr)_minmax(120px,150px)_minmax(150px,190px)]">
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600">Print content</label>
            <Select value={contentMode} onValueChange={(value) => setContentMode(value as PrintContentMode)}>
              <SelectTrigger>
                <SelectValue placeholder="Print content" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="labels">Component labels</SelectItem>
                <SelectItem value="placement">Placement sheet</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600">Case</label>
            <Select value={selectedCaseId} onValueChange={setSelectedCaseId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose case" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All cases</SelectItem>
                {orderedCases.map((case_) => (
                  <SelectItem key={case_.id} value={String(case_.id)}>
                    {case_.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600">Label type</label>
            <Select value={labelFilter} onValueChange={(value) => setLabelFilter(value as LabelFilter)}>
              <SelectTrigger>
                <SelectValue placeholder="Label type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Auto sizes</SelectItem>
                <SelectItem value="full">Full only</SelectItem>
                <SelectItem value="wide">Wide only</SelectItem>
                <SelectItem value="tall">Tall only</SelectItem>
                <SelectItem value="small">Small only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600">Search</label>
            <div className="relative">
              <Input
                type="text"
                placeholder="Filter labels..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="pl-10"
              />
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600">Skip labels</label>
            <Input
              type="text"
              inputMode="numeric"
              value={startOffset}
              onChange={(event) => setStartOffset(event.target.value.replace(/[^\d]/g, ""))}
              onBlur={() => {
                if (startOffset === "") setStartOffset("0");
              }}
              className="text-right font-mono"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600">Cut guides</label>
            <Select value={guideMode} onValueChange={(value) => setGuideMode(value as CutGuideMode)}>
              <SelectTrigger>
                <SelectValue placeholder="Cut guides" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="center">Center marks</SelectItem>
                <SelectItem value="full">Full cut guides</SelectItem>
                <SelectItem value="none">Off</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      <main className="label-preview-area p-6">
        {isLoading ? (
          <div className="no-print flex h-64 items-center justify-center text-gray-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading
          </div>
        ) : hasError ? (
          <div className="no-print rounded-md border border-red-200 bg-red-50 p-6 text-sm text-red-700">
            Label data could not be loaded.
          </div>
        ) : entries.length === 0 ? (
          <div className="no-print rounded-md border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
            No matching components.
          </div>
        ) : (
          <div className="space-y-6">
            <div className="no-print rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              R001 setup: 6mm left/right margins, 13mm top/bottom margins, no label padding. Placement sheet uses the same cuts and prints destination codes like 1-A1.
            </div>

            {pages.map((pageSlots, pageIndex) => (
              <section key={`label-page-${pageIndex}`} className="label-print-page bg-white shadow-sm">
                <div className="print-label-sheet">
                  {pageSlots.map((slot) => (
                    <PrintableLabelSlot
                      key={slot.id}
                      slot={slot}
                      guideMode={guideMode}
                      contentMode={contentMode}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

    </div>
  );
}
