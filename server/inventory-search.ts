import type { IStorage } from "./storage";
import {
  COMPONENT_CATEGORY_BY_ID,
  inferComponentCategory,
  isCategoryWord,
  type ComponentCategory,
} from "@shared/component-categories";

export type InventoryMatchQuality = "exact" | "strong" | "broad";
export type InventoryStockStatus = "available" | "low" | "out";

export interface InventoryLocationResult {
  caseName: string;
  compartment: string;
  layer: "top" | "bottom";
  quantity: number;
}

export interface InventoryCandidateResult {
  name: string;
  category: string;
  packageSize: string | null;
  notes: string | null;
  totalQuantity: number;
  stockStatus: InventoryStockStatus;
  matchQuality: InventoryMatchQuality;
  locations: InventoryLocationResult[];
}

export interface InventorySearchInput {
  need: string;
  category?: ComponentCategory;
  packageSize?: string;
  limit?: number;
}

export interface InventorySearchResult {
  query: string;
  category: ComponentCategory | null;
  totalMatches: number;
  needsClarification: boolean;
  clarificationAxes: string[];
  candidates: InventoryCandidateResult[];
}

interface ElectricalRequirement {
  voltage?: number;
  current?: number;
}

interface RankedStock {
  name: string;
  category: ComponentCategory;
  packageSize: string | null;
  notes: string | null;
  quantity: number;
  minQuantity: number;
  score: number;
  exact: boolean;
  matchedTerms: number;
  requiredTerms: number;
  location: InventoryLocationResult;
  sortKey: string;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "component", "find", "for", "get", "have", "i", "in", "is", "locate",
  "looking", "me", "my", "need", "owned", "part", "please", "the", "to", "use", "want", "where",
]);

const SYNONYM_GROUPS = [
  ["esd", "tvs", "transient", "surge", "clamp", "protection"],
  ["rectifier", "rectification", "flyback", "freewheel", "freewheeling"],
  ["schottky", "fast", "lowdrop"],
  ["zener", "regulator", "reference"],
  ["photo", "photodiode", "optical", "infrared", "ir", "lightsensing"],
  ["decoupling", "bypass"],
] as const;

function canonicalize(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s*(?:kilovolts?|kv)\b/g, (_, amount) => `${Number(amount) * 1000}v`)
    .replace(/(\d+(?:\.\d+)?)\s*(?:volts?|v)\b/g, "$1v")
    .replace(/(\d+(?:\.\d+)?)\s*(?:milliamps?|ma)\b/g, "$1ma")
    .replace(/(\d+(?:\.\d+)?)\s*(?:amps?|a)\b/g, "$1a")
    .replace(/light\s+sensing/g, "lightsensing")
    .replace(/low[ -]?drop/g, "lowdrop")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

function tokens(value: string) {
  return canonicalize(value).split(/\s+/).filter(Boolean);
}

function meaningfulTokens(value: string) {
  return tokens(value).filter(token => !STOP_WORDS.has(token) && !isCategoryWord(token));
}

function expandTerms(rawTerms: string[]) {
  const expanded = new Set(rawTerms);
  for (const term of rawTerms) {
    for (const group of SYNONYM_GROUPS) {
      if (group.includes(term as never)) group.forEach(value => expanded.add(value));
    }
  }
  return expanded;
}

function parseElectricalRequirements(value: string): ElectricalRequirement {
  const canonical = canonicalize(value);
  const voltage = canonical.match(/(?:^|\s)(\d+(?:\.\d+)?)v(?:\s|$)/);
  const milliamps = canonical.match(/(?:^|\s)(\d+(?:\.\d+)?)ma(?:\s|$)/);
  const amps = canonical.match(/(?:^|\s)(\d+(?:\.\d+)?)a(?:\s|$)/);
  return {
    voltage: voltage ? Number(voltage[1]) : undefined,
    current: milliamps ? Number(milliamps[1]) / 1000 : amps ? Number(amps[1]) : undefined,
  };
}

function extractRatings(value: string): { voltages: number[]; currents: number[] } {
  const canonical = canonicalize(value);
  return {
    voltages: Array.from(canonical.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)v(?:\s|$)/g), match => Number(match[1])),
    currents: [
      ...Array.from(canonical.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)ma(?:\s|$)/g), match => Number(match[1]) / 1000),
      ...Array.from(canonical.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)a(?:\s|$)/g), match => Number(match[1])),
    ],
  };
}

function meetsElectricalRequirements(haystack: string, requirements: ElectricalRequirement) {
  const ratings = extractRatings(haystack);
  if (requirements.voltage !== undefined && !ratings.voltages.some(value => value >= requirements.voltage!)) {
    return false;
  }
  if (requirements.current !== undefined && !ratings.currents.some(value => value >= requirements.current!)) {
    return false;
  }
  return true;
}

function clarificationAxes(category: ComponentCategory | undefined, candidates: InventoryCandidateResult[]) {
  if (candidates.length <= 1) return [];
  if (category === "diode") {
    return [
      "function (rectification, ESD/TVS protection, Zener regulation, or light sensing)",
      "required voltage and current",
      "package or mounting constraints",
    ];
  }
  return ["application", "required electrical value or rating", "package or mounting constraints"];
}

function getStockStatus(quantity: number, minimum: number): InventoryStockStatus {
  if (quantity <= 0) return "out";
  if (quantity <= minimum) return "low";
  return "available";
}

export async function searchInventory(
  storage: IStorage,
  input: InventorySearchInput,
): Promise<InventorySearchResult> {
  const need = input.need.trim();
  const queryWords = tokens(need);
  const category = input.category ?? inferComponentCategory(queryWords);
  const rawTerms = meaningfulTokens(need);
  const semanticTerms = rawTerms.filter(term => !/^\d+(?:\.\d+)?(?:v|a|ma)$/.test(term));
  const expandedTerms = expandTerms(rawTerms);
  const normalizedPackage = input.packageSize ? canonicalize(input.packageSize) : null;
  const requirements = parseElectricalRequirements(need);
  const hasElectricalRequirements = requirements.voltage !== undefined || requirements.current !== undefined;
  const categoryOnly = Boolean(category) && rawTerms.length === 0 && !normalizedPackage;
  const ranked: RankedStock[] = [];
  const activeCases = await storage.getCases();

  for (let caseIndex = 0; caseIndex < activeCases.length; caseIndex += 1) {
    const caseSummary = activeCases[caseIndex];
    const caseDetails = await storage.getCaseWithCompartments(caseSummary.id);
    if (!caseDetails || !caseDetails.isActive) continue;

    for (const compartment of caseDetails.compartments) {
      const component = compartment.component;
      if (!component) continue;
      const componentCategory = COMPONENT_CATEGORY_BY_ID.get(component.categoryId) ?? "other";
      if (category && componentCategory !== category) continue;
      if (normalizedPackage && canonicalize(component.packageSize ?? "") !== normalizedPackage) continue;

      const name = canonicalize(component.name);
      const packageName = canonicalize(component.packageSize ?? "");
      const notes = canonicalize(component.notes ?? "");
      const haystack = `${name} ${componentCategory} ${packageName} ${notes}`.trim();
      const exact = rawTerms.length === 1 && name === rawTerms[0];

      if (hasElectricalRequirements && !exact && !meetsElectricalRequirements(haystack, requirements)) {
        continue;
      }

      let score = exact ? 1000 : categoryOnly ? 20 : 0;
      let matchedTerms = 0;
      let matchedSemanticTerms = 0;
      for (const term of rawTerms) {
        const synonyms = Array.from(expandTerms([term]));
        const matched = synonyms.some(candidate => haystack.includes(candidate));
        if (matched) matchedTerms += 1;
        if (matched && semanticTerms.includes(term)) matchedSemanticTerms += 1;
      }
      for (const term of Array.from(expandedTerms)) {
        if (name.includes(term)) score += rawTerms.includes(term) ? 12 : 2;
        if (packageName.includes(term)) score += rawTerms.includes(term) ? 8 : 1;
        if (notes.includes(term)) score += rawTerms.includes(term) ? 5 : 1;
        if (componentCategory.includes(term)) score += 8;
      }
      if (category) score += 8;
      if (hasElectricalRequirements) score += 20;
      if (!exact && !categoryOnly && semanticTerms.length > 0 && matchedSemanticTerms === 0) continue;
      if (!exact && !categoryOnly && score <= (category ? 8 : 0)) continue;

      ranked.push({
        name: component.name,
        category: componentCategory,
        packageSize: component.packageSize ?? null,
        notes: component.notes ?? null,
        quantity: component.quantity,
        minQuantity: component.minQuantity ?? 5,
        score,
        exact,
        matchedTerms,
        requiredTerms: rawTerms.length,
        location: {
          caseName: caseDetails.name,
          compartment: compartment.position,
          layer: compartment.layer === "bottom" ? "bottom" : "top",
          quantity: component.quantity,
        },
        sortKey: `${String(caseIndex).padStart(4, "0")}:${String(compartment.row).padStart(4, "0")}:${String(compartment.col).padStart(4, "0")}:${compartment.layer}`,
      });
    }
  }

  const groups = new Map<string, RankedStock[]>();
  for (const item of ranked) {
    const key = [item.category, canonicalize(item.name), canonicalize(item.packageSize ?? ""), canonicalize(item.notes ?? "")].join("|");
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const grouped = Array.from(groups.values()).map(group => {
    const first = group[0];
    const totalQuantity = group.reduce((sum, item) => sum + item.quantity, 0);
    const minimumQuantity = group.reduce((sum, item) => sum + item.minQuantity, 0);
    const bestScore = Math.max(...group.map(item => item.score));
    const bestMatchedTerms = Math.max(...group.map(item => item.matchedTerms));
    const matchQuality: InventoryMatchQuality = group.some(item => item.exact)
      ? "exact"
      : !categoryOnly && (first.requiredTerms === 0 || bestMatchedTerms === first.requiredTerms)
        ? "strong"
        : "broad";
    return {
      score: bestScore,
      sortKey: group.map(item => item.sortKey).sort()[0],
      candidate: {
        name: first.name,
        category: first.category,
        packageSize: first.packageSize,
        notes: first.notes,
        totalQuantity,
        stockStatus: getStockStatus(totalQuantity, minimumQuantity),
        matchQuality,
        locations: group
          .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
          .map(item => item.location),
      } satisfies InventoryCandidateResult,
    };
  });

  grouped.sort((left, right) => {
    const stockDifference = (left.candidate.stockStatus === "out" ? 1 : 0) - (right.candidate.stockStatus === "out" ? 1 : 0);
    const qualityRank = (quality: InventoryMatchQuality) => quality === "exact" ? 0 : quality === "strong" ? 1 : 2;
    const qualityDifference = qualityRank(left.candidate.matchQuality) - qualityRank(right.candidate.matchQuality);
    return stockDifference || qualityDifference || right.score - left.score || left.sortKey.localeCompare(right.sortKey) || left.candidate.name.localeCompare(right.candidate.name);
  });

  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
  const candidates = grouped.slice(0, limit).map(result => result.candidate);
  const axes = clarificationAxes(category, candidates);
  const needsClarification = candidates.length > 1 && (categoryOnly || candidates.every(candidate => candidate.matchQuality === "broad"));

  return {
    query: need,
    category: category ?? null,
    totalMatches: grouped.length,
    needsClarification,
    clarificationAxes: needsClarification ? axes : [],
    candidates,
  };
}
