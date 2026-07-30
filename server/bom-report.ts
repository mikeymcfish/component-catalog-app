import type { CaseWithCompartments, Compartment, Component } from "@shared/schema";
import { getCaseLayerLayouts, type CaseLayer } from "@shared/case-layouts";

type BomStatus = "matched" | "short" | "missing";

interface ParsedBomItem {
  itemNumber: number;
  reference: string | null;
  name: string;
  description: string;
  requiredQuantity: number;
  raw: Record<string, string>;
}

interface InventoryRecord {
  component: Component;
  case_: CaseWithCompartments;
  compartment: Compartment;
  searchText: string;
}

interface MatchScore {
  score: number;
  confidence: number;
  reasons: string[];
}

export interface BomReportMatch {
  componentId: number;
  name: string;
  packageSize: string | null;
  quantity: number;
  caseId: number;
  caseName: string;
  caseModel: string;
  compartmentId: number;
  position: string;
  row: number;
  col: number;
  layer: string;
  score: number;
  confidence: number;
  reasons: string[];
}

export interface BomReportItem {
  itemNumber: number;
  reference: string | null;
  name: string;
  description: string;
  requiredQuantity: number;
  availableQuantity: number;
  status: BomStatus;
  short: boolean;
  score: number;
  confidence: number;
  matches: BomReportMatch[];
}

export interface BomReportCaseMarker {
  itemNumber: number;
  label: string;
  row: number;
  col: number;
  short: boolean;
}

export interface BomReportCaseLayer {
  layer: CaseLayer;
  rows: number;
  cols: number;
  markers: BomReportCaseMarker[];
}

export interface BomReportCase {
  caseId: number;
  caseName: string;
  caseModel: string;
  layers: BomReportCaseLayer[];
}

export interface BomAiAnalysis {
  enabled: boolean;
  used: boolean;
  model: string | null;
  summary: string | null;
  error?: string;
}

export interface BomLocationReport {
  generatedAt: string;
  sourceFile: string;
  itemCount: number;
  matchedCount: number;
  shortCount: number;
  missingCount: number;
  pdfUrl?: string;
  htmlUrl?: string;
  ai: BomAiAnalysis;
  items: BomReportItem[];
  missing: BomReportItem[];
  cases: BomReportCase[];
}

interface CreateBomReportOptions {
  sourceFile: string;
  buffer: Buffer;
  cases: CaseWithCompartments[];
}

const MATCH_THRESHOLD = 30;
const MAX_AI_ITEMS = 80;
const DEFAULT_HF_MODEL = "Qwen/Qwen2.5-72B-Instruct";

const quantityHeaders = [
  "qty",
  "quantity",
  "count",
  "required",
  "needed",
  "need",
  "bomquantity",
  "orderquantity",
];

const nameHeaders = [
  "name",
  "part",
  "partnumber",
  "partno",
  "mpn",
  "manufacturerpartnumber",
  "manufacturerpn",
  "component",
  "value",
  "item",
];

const descriptionHeaders = [
  "description",
  "desc",
  "notes",
  "comment",
  "comments",
  "details",
  "package",
  "footprint",
];

const referenceHeaders = [
  "reference",
  "references",
  "ref",
  "refs",
  "designator",
  "designators",
];

const stopWords = new Set([
  "and",
  "or",
  "the",
  "with",
  "for",
  "from",
  "component",
  "components",
  "part",
  "parts",
  "package",
  "pkg",
  "qty",
  "quantity",
  "piece",
  "pieces",
  "pcs",
  "each",
  "smd",
  "smt",
  "resistor",
  "capacitor",
  "cap",
  "diode",
  "connector",
  "inductor",
  "ic",
]);

const partNumberSuffixes = [
  "CTP",
  "TRP",
  "TR",
  "T/R",
  "RL",
  "R",
  "T",
];

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/[µμ]/g, "u")
    .replace(/[ΩΩ]/g, " ohm ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string) {
  const tokens = normalizeSearchText(value)
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !stopWords.has(token));

  return new Set(tokens);
}

function getMpnLikeTokens(value: string) {
  return Array.from(tokenize(value)).filter(token =>
    token.length >= 4 &&
    /[a-z]/.test(token) &&
    /\d/.test(token) &&
    !/^\d{4}$/.test(token)
  );
}

function canonicalPartNumber(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function getPartNumberAliases(value: string) {
  const aliases = new Set<string>();
  const rawTokens = value.match(/[a-z0-9][a-z0-9._+\-/]{2,}[a-z0-9]/gi) ?? [];

  for (const rawToken of rawTokens) {
    const canonical = canonicalPartNumber(rawToken);
    if (canonical.length < 4 || !/[A-Z]/.test(canonical) || !/\d/.test(canonical)) continue;

    aliases.add(canonical);

    for (const suffix of partNumberSuffixes) {
      const canonicalSuffix = canonicalPartNumber(suffix);
      if (canonical.endsWith(canonicalSuffix) && canonical.length - canonicalSuffix.length >= 4) {
        aliases.add(canonical.slice(0, -canonicalSuffix.length));
      }
    }
  }

  return aliases;
}

function getBestPartNumberSimilarity(leftText: string, rightText: string) {
  const leftAliases = getPartNumberAliases(leftText);
  const rightAliases = getPartNumberAliases(rightText);
  let best = 0;
  let bestLabel = "";

  for (const left of Array.from(leftAliases)) {
    for (const right of Array.from(rightAliases)) {
      if (left === right) {
        return { score: 1, label: left };
      }

      const shorter = left.length <= right.length ? left : right;
      const longer = left.length > right.length ? left : right;
      if (shorter.length >= 5 && longer.startsWith(shorter)) {
        const suffix = longer.slice(shorter.length);
        const suffixLooksLikePackaging = /^[A-Z]{1,4}\d*$/.test(suffix);
        const score = suffixLooksLikePackaging ? 0.94 : 0.82;
        if (score > best) {
          best = score;
          bestLabel = `${left}~${right}`;
        }
      }
    }
  }

  return { score: best, label: bestLabel };
}

function getPackageTokens(value: string) {
  const normalized = normalizeSearchText(value).replace(/\s+/g, "");
  const matches = normalized.match(/\b(?:0201|0402|0603|0805|1206|1210|1812|2010|2512|sot-?23|sot-?223|soic-?\d+|tssop-?\d+|msop-?\d+|qfn-?\d+|dfn-?\d+|to-?220|to-?92)\b/g);
  return new Set(matches ?? []);
}

function parseQuantity(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.ceil(value));
  }

  const raw = String(value ?? "").replace(/,/g, "").trim();
  const match = raw.match(/\d+(?:\.\d+)?/);
  if (!match) return 1;

  const quantity = Number(match[0]);
  return Number.isFinite(quantity) ? Math.max(1, Math.ceil(quantity)) : 1;
}

function parseDelimitedRows(text: string, delimiter: "," | "\t") {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index++;
      row.push(cell.trim());
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  if (row.some(value => value.length > 0)) rows.push(row);

  return rows;
}

function coalesceField(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value && value.trim()) return value.trim();
  }

  return "";
}

function getRowObject(headers: string[], values: string[]) {
  const row: Record<string, string> = {};
  headers.forEach((header, index) => {
    row[header] = values[index] ?? "";
  });
  return row;
}

function rowHasHeader(values: string[]) {
  const normalized = values.map(normalizeHeader);
  const knownHeaders = new Set([
    ...quantityHeaders,
    ...nameHeaders,
    ...descriptionHeaders,
    ...referenceHeaders,
  ]);

  return normalized.some(header => knownHeaders.has(header));
}

function parseJsonBom(text: string): ParsedBomItem[] | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const rawItems = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "items" in parsed && Array.isArray((parsed as { items: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : parsed && typeof parsed === "object" && "components" in parsed && Array.isArray((parsed as { components: unknown }).components)
        ? (parsed as { components: unknown[] }).components
        : null;

  if (!rawItems) return null;

  return rawItems
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const raw = Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([key, value]) => [normalizeHeader(key), String(value ?? "")])
      );
      const name = coalesceField(raw, nameHeaders) || coalesceField(raw, descriptionHeaders);
      const description = coalesceField(raw, descriptionHeaders);
      if (!name && !description) return null;

      return {
        itemNumber: index + 1,
        reference: coalesceField(raw, referenceHeaders) || null,
        name: name || description,
        description: description === name ? "" : description,
        requiredQuantity: parseQuantity(coalesceField(raw, quantityHeaders)),
        raw,
      } satisfies ParsedBomItem;
    })
    .filter((item): item is ParsedBomItem => Boolean(item));
}

function parseDelimitedBom(text: string): ParsedBomItem[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const rows = parseDelimitedRows(text, delimiter);
  if (rows.length === 0) return [];

  const hasHeader = rowHasHeader(rows[0]);
  const headers = hasHeader
    ? rows[0].map(normalizeHeader)
    : ["name", "description", "quantity", "reference"];
  const dataRows = hasHeader ? rows.slice(1) : rows;

  return dataRows
    .map((values, index) => {
      const row = getRowObject(headers, values);
      const name = coalesceField(row, nameHeaders) || coalesceField(row, descriptionHeaders) || values[0]?.trim() || "";
      const description = coalesceField(row, descriptionHeaders) || (hasHeader ? "" : values[1]?.trim() || "");
      const quantity = parseQuantity(coalesceField(row, quantityHeaders) || (hasHeader ? "" : values[2]));

      if (!name && !description) return null;

      return {
        itemNumber: index + 1,
        reference: coalesceField(row, referenceHeaders) || null,
        name: name || description,
        description: description === name ? "" : description,
        requiredQuantity: quantity,
        raw: row,
      } satisfies ParsedBomItem;
    })
    .filter((item): item is ParsedBomItem => Boolean(item));
}

function parsePlainTextBom(text: string): ParsedBomItem[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      itemNumber: index + 1,
      reference: null,
      name: line,
      description: "",
      requiredQuantity: 1,
      raw: { name: line },
    }));
}

function parseBom(buffer: Buffer, sourceFile: string) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const extension = sourceFile.toLowerCase().split(".").pop() ?? "";

  const jsonItems = extension === "json" || /^[\s\r\n]*[\[{]/.test(text)
    ? parseJsonBom(text)
    : null;
  if (jsonItems) return jsonItems;

  const delimitedItems = parseDelimitedBom(text);
  if (delimitedItems.length > 0) return delimitedItems;

  return parsePlainTextBom(text);
}

function buildInventoryRecords(cases: CaseWithCompartments[]) {
  const records: InventoryRecord[] = [];

  for (const case_ of cases) {
    for (const compartment of case_.compartments) {
      if (!compartment.component) continue;

      const component = compartment.component;
      records.push({
        case_,
        compartment,
        component,
        searchText: [
          component.name,
          component.packageSize,
          component.notes,
        ].filter(Boolean).join(" "),
      });
    }
  }

  return records;
}

function confidenceFromScore(score: number, partSimilarity: number) {
  if (partSimilarity >= 1) return 99;
  if (partSimilarity >= 0.9) return Math.max(92, Math.min(97, Math.round(score)));
  return Math.max(0, Math.min(99, Math.round(score)));
}

function scoreInventoryMatch(item: ParsedBomItem, record: InventoryRecord): MatchScore {
  const queryText = [item.name, item.description, item.reference].filter(Boolean).join(" ");
  const inventoryText = record.searchText;
  const queryNormalized = normalizeSearchText(queryText);
  const inventoryNormalized = normalizeSearchText(inventoryText);
  const componentNameNormalized = normalizeSearchText(record.component.name);
  const itemNameNormalized = normalizeSearchText(item.name);
  const queryTokens = tokenize(queryText);
  const inventoryTokens = tokenize(inventoryText);
  const commonTokens = Array.from(queryTokens).filter(token => inventoryTokens.has(token));
  const queryPackages = getPackageTokens(queryText);
  const inventoryPackages = getPackageTokens(inventoryText);
  const commonNonPackageTokens = commonTokens.filter(token => !queryPackages.has(token) && !inventoryPackages.has(token));
  const exactNameMatch = Boolean(itemNameNormalized && componentNameNormalized === itemNameNormalized);
  const itemNameInInventory = Boolean(itemNameNormalized && inventoryNormalized.includes(itemNameNormalized));
  const componentNameInQuery = Boolean(queryNormalized && componentNameNormalized && queryNormalized.includes(componentNameNormalized));
  const partSimilarity = getBestPartNumberSimilarity(queryText, inventoryText);
  const reasons: string[] = [];

  let score = commonTokens.length * 12;
  const smallestTokenSet = Math.max(1, Math.min(queryTokens.size, inventoryTokens.size));
  score += (commonTokens.length / smallestTokenSet) * 35;

  if (commonTokens.length > 0) {
    reasons.push(`shared terms: ${commonTokens.slice(0, 4).join(", ")}`);
  }

  if (exactNameMatch) {
    score += 55;
    reasons.push("exact item name");
  }
  if (itemNameInInventory) {
    score += 35;
    reasons.push("BOM name appears in inventory text");
  }
  if (componentNameInQuery) {
    score += 25;
    reasons.push("inventory name appears in BOM text");
  }

  for (const token of Array.from(queryPackages)) {
    if (inventoryPackages.has(token)) {
      score += 18;
      reasons.push(`package ${token}`);
    }
  }

  const queryMpns = getMpnLikeTokens(queryText);
  const inventoryMpns = new Set(getMpnLikeTokens(inventoryText));
  let mpnMatchCount = 0;
  for (const token of queryMpns) {
    if (inventoryMpns.has(token)) {
      score += 35;
      mpnMatchCount++;
      reasons.push(`MPN token ${token}`);
    }
  }

  if (partSimilarity.score >= 1) {
    score += 95;
    reasons.unshift(`canonical part ${partSimilarity.label}`);
  } else if (partSimilarity.score >= 0.9) {
    score += 80;
    reasons.unshift(`near canonical part ${partSimilarity.label}`);
  } else if (partSimilarity.score >= 0.8) {
    score += 55;
    reasons.unshift(`possible part prefix ${partSimilarity.label}`);
  }

  if (
    commonNonPackageTokens.length === 0 &&
    mpnMatchCount === 0 &&
    !exactNameMatch &&
    !itemNameInInventory &&
    !componentNameInQuery &&
    partSimilarity.score < 0.8
  ) {
    return { score: 0, confidence: 0, reasons: [] };
  }

  return {
    score: Math.round(score),
    confidence: confidenceFromScore(score, partSimilarity.score),
    reasons: Array.from(new Set(reasons)).slice(0, 5),
  };
}

function locateBomItem(item: ParsedBomItem, inventory: InventoryRecord[]): BomReportItem {
  const candidates = inventory
    .map(record => ({ record, matchScore: scoreInventoryMatch(item, record) }))
    .filter(candidate => candidate.matchScore.score >= MATCH_THRESHOLD)
    .sort((left, right) =>
      right.matchScore.confidence - left.matchScore.confidence ||
      right.matchScore.score - left.matchScore.score ||
      right.record.component.quantity - left.record.component.quantity ||
      left.record.component.id - right.record.component.id
    );

  const matches: BomReportMatch[] = [];
  let availableQuantity = 0;

  for (const candidate of candidates) {
    const { component } = candidate.record;
    const { case_, compartment } = candidate.record;
    availableQuantity += component.quantity;
    matches.push({
      componentId: component.id,
      name: component.name,
      packageSize: component.packageSize,
      quantity: component.quantity,
      caseId: case_.id,
      caseName: case_.name,
      caseModel: case_.model,
      compartmentId: compartment.id,
      position: compartment.position,
      row: compartment.row,
      col: compartment.col,
      layer: compartment.layer,
      score: candidate.matchScore.score,
      confidence: candidate.matchScore.confidence,
      reasons: candidate.matchScore.reasons,
    });

    if (availableQuantity >= item.requiredQuantity) break;
  }

  const status: BomStatus = matches.length === 0
    ? "missing"
    : availableQuantity < item.requiredQuantity
      ? "short"
      : "matched";

  return {
    itemNumber: item.itemNumber,
    reference: item.reference,
    name: item.name,
    description: item.description,
    requiredQuantity: item.requiredQuantity,
    availableQuantity,
    status,
    short: status === "short",
    score: matches[0]?.score ?? 0,
    confidence: matches[0]?.confidence ?? 0,
    matches,
  };
}

function buildReportCases(cases: CaseWithCompartments[], items: BomReportItem[]): BomReportCase[] {
  const markersByCaseLayer = new Map<string, BomReportCaseMarker[]>();

  for (const item of items) {
    for (const match of item.matches) {
      const key = `${match.caseId}:${match.layer}`;
      const markers = markersByCaseLayer.get(key) ?? [];
      markers.push({
        itemNumber: item.itemNumber,
        label: `${item.itemNumber}${item.short ? "*" : ""}`,
        row: match.row,
        col: match.col,
        short: item.short,
      });
      markersByCaseLayer.set(key, markers);
    }
  }

  return cases
    .map(case_ => {
      const layers = getCaseLayerLayouts(case_)
        .map(layout => ({
          ...layout,
          markers: markersByCaseLayer.get(`${case_.id}:${layout.layer}`) ?? [],
        }))
        .filter(layer => layer.markers.length > 0);

      return {
        caseId: case_.id,
        caseName: case_.name,
        caseModel: case_.model,
        layers,
      };
    })
    .filter(case_ => case_.layers.length > 0);
}

export function createBomLocationReport(options: CreateBomReportOptions): BomLocationReport {
  const parsedItems = parseBom(options.buffer, options.sourceFile);
  if (parsedItems.length === 0) {
    throw new Error("No BOM line items were found in the uploaded file");
  }

  const inventory = buildInventoryRecords(options.cases);
  const items = parsedItems.map(item => locateBomItem(item, inventory));
  const missing = items.filter(item => item.status === "missing");

  return {
    generatedAt: new Date().toISOString(),
    sourceFile: options.sourceFile,
    itemCount: items.length,
    matchedCount: items.filter(item => item.status === "matched").length,
    shortCount: items.filter(item => item.status === "short").length,
    missingCount: missing.length,
    ai: {
      enabled: Boolean(getHuggingFaceToken()),
      used: false,
      model: process.env.HF_INFERENCE_MODEL || DEFAULT_HF_MODEL,
      summary: null,
    },
    items,
    missing,
    cases: buildReportCases(options.cases, items),
  };
}

function getHuggingFaceToken() {
  return process.env.HF_TOKEN ||
    process.env.HUGGINGFACE_API_KEY ||
    process.env.HUGGINGFACEHUB_API_TOKEN ||
    "";
}

function getAiReportPayload(report: BomLocationReport) {
  return {
    sourceFile: report.sourceFile,
    counts: {
      items: report.itemCount,
      matched: report.matchedCount,
      short: report.shortCount,
      missing: report.missingCount,
    },
    items: report.items.slice(0, MAX_AI_ITEMS).map(item => ({
      number: item.itemNumber,
      name: item.name,
      description: item.description,
      required: item.requiredQuantity,
      available: item.availableQuantity,
      status: item.status,
      confidence: item.confidence,
      matches: item.matches.map(match => ({
        name: match.name,
        packageSize: match.packageSize,
        quantity: match.quantity,
        location: `${match.caseName} ${match.layer} ${match.position}`,
        score: match.score,
        confidence: match.confidence,
        reasons: match.reasons,
      })),
    })),
  };
}

export async function analyzeBomWithHuggingFace(report: BomLocationReport): Promise<BomAiAnalysis> {
  const token = getHuggingFaceToken();
  const model = process.env.HF_INFERENCE_MODEL || DEFAULT_HF_MODEL;

  if (!token) {
    return {
      enabled: false,
      used: false,
      model,
      summary: null,
    };
  }

  try {
    const response = await fetch("https://router.huggingface.co/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: "You review electronics BOM-to-inventory matches. Return a concise practical analysis with match concerns, likely false positives, shortage notes, and purchase priorities. Do not reveal hidden chain-of-thought.",
          },
          {
            role: "user",
            content: JSON.stringify(getAiReportPayload(report)),
          },
        ],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Hugging Face returned ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
    };

    return {
      enabled: true,
      used: true,
      model,
      summary: data.choices?.[0]?.message?.content?.trim() || null,
    };
  } catch (error) {
    return {
      enabled: true,
      used: false,
      model,
      summary: null,
      error: error instanceof Error ? error.message : "Hugging Face analysis failed",
    };
  }
}

const pageWidth = 612;
const pageHeight = 792;
const margin = 36;

class PdfPage {
  readonly commands: string[] = [];
  y = pageHeight - margin;

  text(x: number, y: number, size: number, text: string, bold = false) {
    this.commands.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdfText(text)}) Tj ET`);
  }

  centeredText(x: number, y: number, size: number, text: string, bold = false) {
    const width = sanitizePdfText(text).length * size * 0.48;
    this.text(x - width / 2, y, size, text, bold);
  }

  rect(x: number, y: number, width: number, height: number) {
    this.commands.push(`${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S`);
  }

  line(x1: number, y1: number, x2: number, y2: number) {
    this.commands.push(`${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }
}

function sanitizePdfText(text: string) {
  return text.replace(/[^\x20-\x7e]/g, "?");
}

function escapePdfText(text: string) {
  return sanitizePdfText(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapText(text: string, maxChars: number) {
  const words = sanitizePdfText(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    if (`${current} ${word}`.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function rowLabel(row: number) {
  if (row >= 1 && row <= 26) return String.fromCharCode(64 + row);
  return String(row);
}

function createPdfBuilder() {
  const pages: PdfPage[] = [];

  const addPage = () => {
    const page = new PdfPage();
    pages.push(page);
    return page;
  };

  const ensureSpace = (page: PdfPage, requiredHeight: number) => {
    if (page.y - requiredHeight < margin) {
      return addPage();
    }
    return page;
  };

  return { pages, addPage, ensureSpace };
}

function drawParagraph(builder: ReturnType<typeof createPdfBuilder>, page: PdfPage, text: string, size = 9, maxChars = 95) {
  let currentPage = page;
  for (const line of wrapText(text, maxChars)) {
    currentPage = builder.ensureSpace(currentPage, size + 6);
    currentPage.text(margin, currentPage.y, size, line);
    currentPage.y -= size + 4;
  }
  return currentPage;
}

function drawGridLayer(builder: ReturnType<typeof createPdfBuilder>, page: PdfPage, reportCase: BomReportCase, layer: BomReportCaseLayer) {
  let currentPage = page;
  const rowHeaderWidth = 20;
  const colHeaderHeight = 13;
  const availableWidth = pageWidth - margin * 2 - rowHeaderWidth;
  const cellWidth = Math.max(16, Math.min(34, availableWidth / layer.cols));
  const cellHeight = Math.max(14, Math.min(24, cellWidth * 0.78));
  const markerMap = new Map<string, string[]>();

  for (const marker of layer.markers) {
    const key = `${marker.row}:${marker.col}`;
    const markers = markerMap.get(key) ?? [];
    markers.push(marker.label);
    markerMap.set(key, markers);
  }

  let startRow = 1;
  while (startRow <= layer.rows) {
    const maxRowsOnPage = Math.max(1, Math.floor((currentPage.y - margin - 42) / cellHeight));
    const rowCount = Math.min(layer.rows - startRow + 1, maxRowsOnPage);
    const neededHeight = 36 + colHeaderHeight + rowCount * cellHeight;
    currentPage = builder.ensureSpace(currentPage, neededHeight);

    const endRow = startRow + rowCount - 1;
    const title = `${reportCase.caseName} (${reportCase.caseModel}) - ${layer.layer}${layer.rows > rowCount ? ` rows ${startRow}-${endRow}` : ""}`;
    currentPage.text(margin, currentPage.y, 11, title, true);
    currentPage.y -= 18;

    const gridTop = currentPage.y - colHeaderHeight;
    for (let col = 1; col <= layer.cols; col++) {
      const x = margin + rowHeaderWidth + (col - 1) * cellWidth;
      currentPage.centeredText(x + cellWidth / 2, currentPage.y - 9, 6, String(col));
    }

    for (let row = startRow; row <= endRow; row++) {
      const y = gridTop - (row - startRow + 1) * cellHeight;
      currentPage.text(margin, y + cellHeight * 0.35, 6, rowLabel(row));

      for (let col = 1; col <= layer.cols; col++) {
        const x = margin + rowHeaderWidth + (col - 1) * cellWidth;
        currentPage.rect(x, y, cellWidth, cellHeight);
        const labels = markerMap.get(`${row}:${col}`);
        if (labels?.length) {
          const label = labels.slice(0, 3).join(",");
          currentPage.centeredText(x + cellWidth / 2, y + cellHeight * 0.38, labels.length > 2 ? 6 : 8, label, true);
        }
      }
    }

    currentPage.y = gridTop - rowCount * cellHeight - 22;
    startRow = endRow + 1;
    if (startRow <= layer.rows) currentPage = builder.addPage();
  }

  return currentPage;
}

function drawItemList(builder: ReturnType<typeof createPdfBuilder>, page: PdfPage, report: BomLocationReport) {
  let currentPage = builder.ensureSpace(page, 32);
  currentPage.text(margin, currentPage.y, 13, "BOM Items", true);
  currentPage.y -= 18;
  currentPage.line(margin, currentPage.y, pageWidth - margin, currentPage.y);
  currentPage.y -= 12;

  for (const item of report.items) {
    currentPage = builder.ensureSpace(currentPage, 50);
    const status = item.status === "short" ? "SHORT*" : item.status.toUpperCase();
    const location = item.matches.length
      ? item.matches.map(match => `${match.caseName} ${match.layer} ${match.position}`).join("; ")
      : "Not found";
    const confidence = item.matches.length ? ` | match ${item.confidence}%` : "";
    const headline = `${item.itemNumber}${item.short ? "*" : ""}. ${item.name} | need ${item.requiredQuantity}, have ${item.availableQuantity} | ${status}${confidence}`;
    currentPage.text(margin, currentPage.y, 9, headline, true);
    currentPage.y -= 12;
    currentPage = drawParagraph(builder, currentPage, `Location: ${location}`, 8, 105);
    if (item.description) {
      currentPage = drawParagraph(builder, currentPage, `BOM description: ${item.description}`, 8, 105);
    }
    currentPage.y -= 5;
  }

  return currentPage;
}

function drawMissingList(builder: ReturnType<typeof createPdfBuilder>, page: PdfPage, report: BomLocationReport) {
  let currentPage = builder.ensureSpace(page, 40);
  currentPage.text(margin, currentPage.y, 13, "Not In Inventory", true);
  currentPage.y -= 18;

  if (report.missing.length === 0) {
    currentPage.text(margin, currentPage.y, 9, "No missing BOM lines.");
    currentPage.y -= 18;
    return currentPage;
  }

  for (const item of report.missing) {
    currentPage = builder.ensureSpace(currentPage, 28);
    currentPage.text(margin, currentPage.y, 9, `${item.itemNumber}. ${item.name} | need ${item.requiredQuantity}`, true);
    currentPage.y -= 12;
    if (item.description) {
      currentPage = drawParagraph(builder, currentPage, item.description, 8, 105);
    }
    currentPage.y -= 4;
  }

  return currentPage;
}

function buildPdf(pages: PdfPage[]) {
  const objects: string[] = [];
  const addObject = (value: string) => {
    objects.push(value);
    return objects.length;
  };

  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject("");
  const fontRegularId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBoldId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pageIds: number[] = [];

  for (const page of pages) {
    const content = ["q", "0 0 0 RG", "0 0 0 rg", ...page.commands, "Q"].join("\n");
    const contentId = addObject(`<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index++) {
    pdf += `${offsets[index].toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "utf8");
}

export function renderBomLocationReportPdf(report: BomLocationReport) {
  const builder = createPdfBuilder();
  let page = builder.addPage();

  page.text(margin, page.y, 18, "BOM Location Report", true);
  page.y -= 24;
  page.text(margin, page.y, 9, `Source: ${report.sourceFile}`);
  page.y -= 13;
  page.text(margin, page.y, 9, `Generated: ${new Date(report.generatedAt).toLocaleString("en-US")}`);
  page.y -= 18;
  page.text(
    margin,
    page.y,
    10,
    `Items: ${report.itemCount}   Matched: ${report.matchedCount}   Short: ${report.shortCount}   Missing: ${report.missingCount}`,
    true,
  );
  page.y -= 18;
  page.text(margin, page.y, 8, "An asterisk marks BOM items that exist in inventory but have less quantity than requested.");
  page.y -= 26;

  if (report.cases.length > 0) {
    page.text(margin, page.y, 13, "Location Grids", true);
    page.y -= 20;
    for (const reportCase of report.cases) {
      for (const layer of reportCase.layers) {
        page = drawGridLayer(builder, page, reportCase, layer);
      }
    }
  } else {
    page.text(margin, page.y, 10, "No BOM items matched inventory locations.", true);
    page.y -= 24;
  }

  page = drawItemList(builder, page, report);
  drawMissingList(builder, page, report);

  return buildPdf(builder.pages);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeScriptJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderBomLocationReportHtml(report: BomLocationReport) {
  const title = `BOM Location Report - ${report.sourceFile}`;
  const pdfLink = report.pdfUrl
    ? `<a class="button" href="${escapeHtml(report.pdfUrl)}" target="_blank" rel="noreferrer">Open PDF</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --border: #d8dde6;
      --text: #172033;
      --muted: #667085;
      --matched: #167647;
      --short: #b54708;
      --missing: #b42318;
      --accent: #2454a6;
      --accent-soft: #eaf1ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 5;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      padding: 18px 24px;
    }
    h1, h2, h3 { margin: 0; }
    h1 { font-size: 22px; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 14px; margin-bottom: 6px; }
    .subhead { color: var(--muted); margin-top: 6px; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-top: 14px;
    }
    input, select, button, .button {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      min-height: 34px;
      padding: 7px 10px;
      font: inherit;
    }
    input { min-width: min(460px, 100%); flex: 1; }
    button, .button {
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    button.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    main {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 330px;
      gap: 16px;
      padding: 16px 24px 28px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; font-size: 22px; margin-top: 4px; }
    .layers {
      display: grid;
      gap: 14px;
      margin-bottom: 16px;
    }
    .case-layer { overflow-x: auto; }
    .grid-wrap {
      display: inline-grid;
      grid-template-columns: 28px var(--grid-cols);
      grid-auto-rows: 34px;
      gap: 0;
      min-width: 100%;
    }
    .corner, .col-label, .row-label {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      font-size: 11px;
    }
    .cell {
      border: 1px solid #263244;
      border-left-width: 0;
      border-top-width: 0;
      min-width: 42px;
      background: #fff;
      padding: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 2px;
      flex-wrap: wrap;
    }
    .cell.first-col { border-left-width: 1px; }
    .cell.first-row { border-top-width: 1px; }
    .marker {
      min-height: 24px;
      min-width: 28px;
      padding: 2px 5px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 700;
      line-height: 1;
    }
    .marker.short { background: #fff4e5; color: var(--short); }
    .marker.selected { outline: 3px solid #8cb8ff; }
    .items-table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      padding: 9px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      background: #fafbfc;
      position: sticky;
      top: 107px;
      z-index: 3;
    }
    tr.item-row { cursor: pointer; }
    tr.item-row:hover, tr.item-row.selected { background: var(--accent-soft); }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--border);
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .pill.matched { color: var(--matched); border-color: #abefc6; background: #ecfdf3; }
    .pill.short { color: var(--short); border-color: #fedf89; background: #fffaeb; }
    .pill.missing { color: var(--missing); border-color: #fecdca; background: #fef3f2; }
    .muted { color: var(--muted); }
    .detail {
      position: sticky;
      top: 116px;
      max-height: calc(100vh - 140px);
      overflow: auto;
    }
    .detail-section { margin-top: 12px; }
    .match-card {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      margin-top: 8px;
      background: #fff;
    }
    .hidden { display: none !important; }
    @media (max-width: 980px) {
      main { grid-template-columns: 1fr; padding: 12px; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .detail { position: static; max-height: none; }
      th { position: static; }
      header { position: static; }
    }
    @media print {
      header, .detail, .toolbar { position: static; }
      main { display: block; padding: 0; }
      .panel { border: 0; border-radius: 0; break-inside: avoid; }
      .items-table { font-size: 11px; }
      button, .button, input, select { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <h1>BOM Location Report</h1>
    <div class="subhead">${escapeHtml(report.sourceFile)} - generated ${escapeHtml(new Date(report.generatedAt).toLocaleString("en-US"))}</div>
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search items, descriptions, locations, or match reasons">
      <select id="statusFilter" aria-label="Status filter">
        <option value="all">All statuses</option>
        <option value="matched">Matched</option>
        <option value="short">Short only</option>
        <option value="missing">Missing only</option>
      </select>
      <button type="button" id="clearSelection">Clear Selection</button>
      ${pdfLink}
    </div>
  </header>
  <main>
    <section>
      <div class="summary">
        <div class="metric"><span>Items</span><strong>${report.itemCount}</strong></div>
        <div class="metric"><span>Matched</span><strong>${report.matchedCount}</strong></div>
        <div class="metric"><span>Short*</span><strong>${report.shortCount}</strong></div>
        <div class="metric"><span>Missing</span><strong>${report.missingCount}</strong></div>
      </div>
      <div class="panel">
        <h2>Location Grids</h2>
        <div id="layers" class="layers"></div>
      </div>
      <div class="panel" style="margin-top:16px">
        <h2>BOM Items</h2>
        <table class="items-table">
          <thead>
            <tr>
              <th style="width:68px">#</th>
              <th>Item</th>
              <th style="width:72px">Need</th>
              <th style="width:72px">Have</th>
              <th style="width:92px">Match</th>
              <th style="width:96px">Status</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody id="itemsBody"></tbody>
        </table>
      </div>
    </section>
    <aside class="panel detail">
      <h2>Selection</h2>
      <div id="detail"><p class="muted">Choose an item number in a grid or table.</p></div>
    </aside>
  </main>
  <script>
    const report = ${escapeScriptJson(report)};
    const itemByNumber = new Map(report.items.map(item => [item.itemNumber, item]));
    let selectedItemNumber = null;

    const rowLabel = (row) => row >= 1 && row <= 26 ? String.fromCharCode(64 + row) : String(row);
    const statusLabel = (item) => item.status === "short" ? "Short*" : item.status.charAt(0).toUpperCase() + item.status.slice(1);
    const locationSummary = (item) => item.matches.length
      ? item.matches.map(match => \`\${match.caseName} \${match.layer} \${match.position}\`).join("; ")
      : "Not found";
    const searchableText = (item) => [
      item.itemNumber,
      item.name,
      item.description,
      item.reference,
      item.status,
      item.confidence,
      locationSummary(item),
      ...item.matches.flatMap(match => [match.name, match.packageSize, ...(match.reasons || [])]),
    ].filter(Boolean).join(" ").toLowerCase();

    function escapeText(value) {
      return String(value ?? "").replace(/[&<>"]/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      }[char]));
    }

    function markerVisible(item) {
      const term = document.getElementById("search").value.trim().toLowerCase();
      const status = document.getElementById("statusFilter").value;
      if (status !== "all" && item.status !== status) return false;
      return !term || searchableText(item).includes(term);
    }

    function renderLayers() {
      const layersEl = document.getElementById("layers");
      layersEl.innerHTML = "";

      if (!report.cases.length) {
        layersEl.innerHTML = '<p class="muted">No matched inventory locations.</p>';
        return;
      }

      for (const caseReport of report.cases) {
        for (const layer of caseReport.layers) {
          const section = document.createElement("section");
          section.className = "case-layer";
          section.innerHTML = \`<h3>\${escapeText(caseReport.caseName)} (\${escapeText(caseReport.caseModel)}) - \${escapeText(layer.layer)}</h3>\`;

          const wrap = document.createElement("div");
          wrap.className = "grid-wrap";
          wrap.style.setProperty("--grid-cols", \`repeat(\${layer.cols}, minmax(42px, 1fr))\`);
          wrap.innerHTML = '<div class="corner"></div>';
          for (let col = 1; col <= layer.cols; col++) {
            wrap.insertAdjacentHTML("beforeend", \`<div class="col-label">\${col}</div>\`);
          }

          const markerMap = new Map();
          for (const marker of layer.markers) {
            const markers = markerMap.get(\`\${marker.row}:\${marker.col}\`) || [];
            markers.push(marker);
            markerMap.set(\`\${marker.row}:\${marker.col}\`, markers);
          }

          for (let row = 1; row <= layer.rows; row++) {
            wrap.insertAdjacentHTML("beforeend", \`<div class="row-label">\${rowLabel(row)}</div>\`);
            for (let col = 1; col <= layer.cols; col++) {
              const cell = document.createElement("div");
              cell.className = \`cell \${col === 1 ? "first-col" : ""} \${row === 1 ? "first-row" : ""}\`;
              for (const marker of markerMap.get(\`\${row}:\${col}\`) || []) {
                const item = itemByNumber.get(marker.itemNumber);
                if (!item) continue;
                const button = document.createElement("button");
                button.type = "button";
                button.className = \`marker \${item.short ? "short" : ""} \${selectedItemNumber === item.itemNumber ? "selected" : ""}\`;
                button.dataset.item = String(item.itemNumber);
                button.title = \`#\${item.itemNumber}: \${item.name} (\${item.confidence || 0}% match)\`;
                button.textContent = marker.label;
                button.hidden = !markerVisible(item);
                button.addEventListener("click", () => selectItem(item.itemNumber));
                cell.appendChild(button);
              }
              wrap.appendChild(cell);
            }
          }
          section.appendChild(wrap);
          layersEl.appendChild(section);
        }
      }
    }

    function renderItems() {
      const term = document.getElementById("search").value.trim().toLowerCase();
      const status = document.getElementById("statusFilter").value;
      const body = document.getElementById("itemsBody");
      body.innerHTML = "";

      for (const item of report.items) {
        if (status !== "all" && item.status !== status) continue;
        if (term && !searchableText(item).includes(term)) continue;

        const row = document.createElement("tr");
        row.className = \`item-row \${selectedItemNumber === item.itemNumber ? "selected" : ""}\`;
        row.dataset.item = String(item.itemNumber);
        row.innerHTML = \`
          <td><strong>\${item.itemNumber}\${item.short ? "*" : ""}</strong></td>
          <td><strong>\${escapeText(item.name)}</strong>\${item.description ? \`<div class="muted">\${escapeText(item.description)}</div>\` : ""}</td>
          <td>\${item.requiredQuantity}</td>
          <td>\${item.availableQuantity}</td>
          <td>\${item.matches.length ? item.confidence + "%" : "-"}</td>
          <td><span class="pill \${item.status}">\${statusLabel(item)}</span></td>
          <td>\${escapeText(locationSummary(item))}</td>
        \`;
        row.addEventListener("click", () => selectItem(item.itemNumber));
        body.appendChild(row);
      }
    }

    function renderDetail() {
      const detail = document.getElementById("detail");
      const item = selectedItemNumber ? itemByNumber.get(selectedItemNumber) : null;
      if (!item) {
        detail.innerHTML = '<p class="muted">Choose an item number in a grid or table.</p>';
        return;
      }

      detail.innerHTML = \`
        <div class="detail-section">
          <h3>#\${item.itemNumber}\${item.short ? "*" : ""} \${escapeText(item.name)}</h3>
          \${item.description ? \`<p class="muted">\${escapeText(item.description)}</p>\` : ""}
          \${item.reference ? \`<p><strong>Refs:</strong> \${escapeText(item.reference)}</p>\` : ""}
          <p><strong>Needed:</strong> \${item.requiredQuantity} <strong>Have:</strong> \${item.availableQuantity}</p>
          <p><strong>Status:</strong> <span class="pill \${item.status}">\${statusLabel(item)}</span></p>
          <p><strong>Best match:</strong> \${item.matches.length ? item.confidence + "%" : "none"}</p>
        </div>
        <div class="detail-section">
          <h3>Matches</h3>
          \${item.matches.length ? item.matches.map(match => \`
            <div class="match-card">
              <strong>\${escapeText(match.name)}</strong>
              <div class="muted">\${escapeText(match.caseName)} \${escapeText(match.layer)} \${escapeText(match.position)}</div>
              <div>Qty \${match.quantity} - \${match.confidence}% match</div>
              \${match.packageSize ? \`<div>Package: \${escapeText(match.packageSize)}</div>\` : ""}
              \${match.reasons?.length ? \`<div class="muted">Reasons: \${match.reasons.map(escapeText).join("; ")}</div>\` : ""}
            </div>
          \`).join("") : '<p class="muted">No inventory match.</p>'}
        </div>
      \`;
    }

    function selectItem(itemNumber) {
      selectedItemNumber = itemNumber;
      renderLayers();
      renderItems();
      renderDetail();
    }

    function renderAll() {
      renderLayers();
      renderItems();
      renderDetail();
    }

    document.getElementById("search").addEventListener("input", renderAll);
    document.getElementById("statusFilter").addEventListener("change", renderAll);
    document.getElementById("clearSelection").addEventListener("click", () => {
      selectedItemNumber = null;
      renderAll();
    });

    renderAll();
  </script>
</body>
</html>`;
}
