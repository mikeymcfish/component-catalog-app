import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import {
  insertCaseSchema,
  insertComponentBookItemSchema,
  insertComponentBookSchema,
  insertComponentSchema,
  insertAdapterSchema,
  insertToolSchema,
  adapterEndpointTypeSchema,
  type CaseWithCompartments,
  type InsertCase,
} from "@shared/schema";
import { getCaseDefaults, getCustomCaseModel } from "@shared/case-layouts";
import {
  createUniformCustomCaseLayout,
  parseCustomCaseLayout,
} from "@shared/custom-case-layout";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "node:crypto";
import { z, ZodError } from "zod";
import {
  analyzeBomWithHuggingFace,
  createBomLocationReport,
  renderBomLocationReportHtml,
  renderBomLocationReportPdf,
} from "./bom-report";
import { ModelAssetService, registerModelAssetRoutes } from "./model-assets";
import { getRuntimeAccessMetadata } from "./lan-access";
import {
  ensureDefaultCaseModels,
  isCompleteDefaultCaseModelCatalog,
  loadDefaultCaseModelCatalog,
  seedMissingDefaultCaseModels,
} from "./default-case-models";
import {
  caseModelCalibrationSchema,
  deleteCaseModelCalibrationSchema,
  getManagedModelAssetId,
} from "@shared/model-calibration";
import { parseComponentModelRotationForModel } from "@shared/component-model-rotation";

type AssetType = "datasheet" | "photo";
type AssetKind = "pdf" | "image" | "html" | "other";

interface FetchedAsset {
  buffer: Buffer;
  contentType: string;
  url: URL;
}

interface ImageCandidate {
  url: string;
  score: number;
  order: number;
}

const MAX_ASSET_SIZE = 10 * 1024 * 1024;
const uploadsRoot = process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads");
const uploadSubdirs: Record<AssetType, string> = {
  datasheet: "datasheets",
  photo: "photos",
};
const reportSubdir = "reports";
const caseImageSubdir = "case-images";
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"]);
const caseImageExtensions = new Set([".jpg", ".png", ".webp"]);
const caseImageUrlSchema = z.string().regex(
  /^\/uploads\/case-images\/[a-f0-9]{64}\.(?:jpg|png|webp)$/,
  "Case images must be uploaded through the case image manager",
);
const modelAssetUrlSchema = z.string().regex(/^\/uploads\/models\/[a-f0-9]{64}\.glb$/);
const modelAssetNameSchema = z.string().trim().min(1).max(200);
const modelAssetSourceSchema = z.enum(["kicad", "upload"]);

function ensureUploadDirectories() {
  fs.mkdirSync(uploadsRoot, { recursive: true });
  for (const subdir of Object.values(uploadSubdirs)) {
    fs.mkdirSync(path.join(uploadsRoot, subdir), { recursive: true });
  }
  fs.mkdirSync(path.join(uploadsRoot, reportSubdir), { recursive: true });
  fs.mkdirSync(path.join(uploadsRoot, caseImageSubdir), { recursive: true });
}

function getAssetTypeFromField(fieldName: string): AssetType {
  return fieldName === "photo" ? "photo" : "datasheet";
}

function getKnownExtensionFromContentType(contentType: string) {
  const normalizedType = contentType.toLowerCase().split(";")[0].trim();

  if (normalizedType === "application/pdf") return ".pdf";
  if (normalizedType === "image/jpeg" || normalizedType === "image/jpg") return ".jpg";
  if (normalizedType === "image/png") return ".png";
  if (normalizedType === "image/webp") return ".webp";
  if (normalizedType === "image/gif") return ".gif";
  if (normalizedType === "image/svg+xml") return ".svg";

  return "";
}

function getExtensionFromBuffer(buffer: Buffer) {
  if (buffer.subarray(0, 4).toString("utf8") === "%PDF") return ".pdf";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.subarray(1, 4).toString("ascii") === "PNG") return ".png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return ".gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";

  const textStart = buffer.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (textStart.startsWith("<svg") || (textStart.startsWith("<?xml") && textStart.includes("<svg"))) return ".svg";

  return "";
}

function getAssetKind(buffer: Buffer, contentType: string): AssetKind {
  const extension = getExtensionFromBuffer(buffer);
  if (extension === ".pdf") return "pdf";
  if (imageExtensions.has(extension)) return "image";

  const textStart = buffer.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (textStart.startsWith("<!doctype html") || textStart.startsWith("<html") || textStart.startsWith("<!--")) {
    return "html";
  }

  const normalizedType = contentType.toLowerCase().split(";")[0].trim();
  if (normalizedType === "application/pdf") return "pdf";
  if (normalizedType === "text/html" || normalizedType === "application/xhtml+xml") return "html";

  return "other";
}

function getImageMimeTypeFromBuffer(buffer: Buffer) {
  const extension = getExtensionFromBuffer(buffer);
  switch (extension) {
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      return "";
  }
}

function getExtensionFromUrl(url: URL) {
  const extension = path.extname(url.pathname).toLowerCase();
  return extension.match(/^\.[a-z0-9]{1,8}$/) ? extension : "";
}

function getAllowedExtensionFromUrl(url: URL, assetType: AssetType) {
  const extension = getExtensionFromUrl(url);
  if (assetType === "datasheet") return extension === ".pdf" ? extension : "";
  return imageExtensions.has(extension) ? extension : "";
}

function buildAssetFilename(extension: string) {
  return `${Date.now()}-${crypto.randomUUID()}${extension}`;
}

function buildReportFilename(extension: ".pdf" | ".html") {
  return `${Date.now()}-${crypto.randomUUID()}${extension}`;
}

function saveReportPdf(buffer: Buffer) {
  const filename = buildReportFilename(".pdf");
  fs.writeFileSync(path.join(uploadsRoot, reportSubdir, filename), buffer);
  return `/uploads/${reportSubdir}/${filename}`;
}

function saveReportHtml(html: string) {
  const filename = buildReportFilename(".html");
  fs.writeFileSync(path.join(uploadsRoot, reportSubdir, filename), html, "utf8");
  return `/uploads/${reportSubdir}/${filename}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, file, cb) => {
      const assetType = getAssetTypeFromField(file.fieldname);
      cb(null, path.join(uploadsRoot, uploadSubdirs[assetType]));
    },
    filename: (_req, file, cb) => {
      const assetType = getAssetTypeFromField(file.fieldname);
      const extension = path.extname(file.originalname) || getKnownExtensionFromContentType(file.mimetype) || (assetType === "datasheet" ? ".pdf" : ".img");
      cb(null, buildAssetFilename(extension));
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const caseImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ASSET_SIZE, files: 1 },
});

function receiveCaseImage(req: Request, res: Response, next: NextFunction) {
  caseImageUpload.single("image")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ message: "Case images must be 10 MB or smaller" });
      return;
    }

    res.status(400).json({ message: "Invalid case image upload" });
  });
}

const bomUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

const createCaseBodySchema = insertCaseSchema.extend({
  model: z.string().min(1).optional(),
  rows: z.coerce.number().int().min(1).max(26).optional(),
  cols: z.coerce.number().int().min(1).max(24).optional(),
  hasBottom: z.boolean().optional().nullable(),
  closedImageUrl: caseImageUrlSchema.optional().nullable(),
  openImageUrl: caseImageUrlSchema.optional().nullable(),
  topModel3dUrl: modelAssetUrlSchema.optional().nullable(),
  topModel3dName: modelAssetNameSchema.optional().nullable(),
  topModel3dSource: modelAssetSourceSchema.optional().nullable(),
  topModel3dCalibration: caseModelCalibrationSchema.optional().nullable(),
  bottomModel3dUrl: modelAssetUrlSchema.optional().nullable(),
  bottomModel3dName: modelAssetNameSchema.optional().nullable(),
  bottomModel3dSource: modelAssetSourceSchema.optional().nullable(),
  bottomModel3dCalibration: caseModelCalibrationSchema.optional().nullable(),
}).superRefine((data, context) => {
  if (!data.model && !(data.rows && data.cols)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either model or rows/cols are required",
      path: ["model"],
    });
  }

  for (const [part, calibration, modelUrl] of [
    ["top", data.topModel3dCalibration, data.topModel3dUrl],
    ["bottom", data.bottomModel3dCalibration, data.bottomModel3dUrl],
  ] as const) {
    if (calibration && calibration.assetId !== getManagedModelAssetId(modelUrl)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${part === "top" ? "Top" : "Bottom"} calibration must match its active model asset`,
        path: [`${part}Model3dCalibration`],
      });
    }
  }
});

const reorderCasesBodySchema = z.object({
  caseIds: z.array(z.coerce.number().int().positive()).min(1),
});

const updateCaseBodySchema = insertCaseSchema.omit({
  model: true,
  rows: true,
  cols: true,
  hasBottom: true,
  layoutGeometry: true,
  topModel3dCalibration: true,
  bottomModel3dCalibration: true,
  topModel3dUrl: true,
  topModel3dName: true,
  topModel3dSource: true,
  bottomModel3dUrl: true,
  bottomModel3dName: true,
  bottomModel3dSource: true,
}).partial().extend({
  closedImageUrl: caseImageUrlSchema.optional().nullable(),
  openImageUrl: caseImageUrlSchema.optional().nullable(),
}).strict();

const caseImageVariantSchema = z.enum(["closed", "open"]);
const caseModelPartSchema = z.enum(["top", "bottom"]);

function getFallbackCaseModel(rows: number, cols: number, hasBottom: boolean) {
  if (hasBottom) {
    if (rows === 4 && cols === 6) return "LAYOUT-6x4-BOTH";
    if (rows === 6 && cols === 12) return "LAYOUT-12x6-BOTH";
    return getCustomCaseModel(rows, cols, true);
  }

  if (rows === 6 && cols === 12) return "BOX-ALL-144";
  if (rows === 4 && cols === 6) return "BOX-ALL-48";
  if (rows === 2 && cols === 6) return "BOX-ALL-24";
  return getCustomCaseModel(rows, cols, false);
}

const categoryIds: Record<string, number> = {
  resistor: 1,
  capacitor: 2,
  ic: 3,
  diode: 4,
  transistor: 5,
  inductor: 6,
  crystal: 7,
  connector: 8,
  led: 9,
  switch: 10,
  sensor: 11,
  other: 12,
};

const createComponentBodySchema = insertComponentSchema.extend({
  categoryId: z.coerce.number().int().positive().optional(),
  category: z.string().min(1).optional(),
  packageSize: z.string().optional().nullable(),
  quantity: z.coerce.number().int().min(0).optional(),
  minQuantity: z.coerce.number().int().min(1).optional().nullable(),
  model3dUrl: z.string().regex(/^\/uploads\/models\/[a-f0-9]{64}\.glb$/).optional().nullable(),
  model3dName: z.string().trim().min(1).max(200).optional().nullable(),
  model3dSource: z.enum(["kicad", "upload"]).optional().nullable(),
}).refine((data) => data.categoryId || data.category, {
  message: "Either categoryId or category is required",
  path: ["categoryId"],
});

const updateComponentBodySchema = insertComponentSchema.partial().extend({
  categoryId: z.coerce.number().int().positive().optional(),
  category: z.string().min(1).optional(),
  packageSize: z.string().optional().nullable(),
  quantity: z.coerce.number().int().min(0).optional(),
  minQuantity: z.coerce.number().int().min(1).optional().nullable(),
  model3dUrl: z.string().regex(/^\/uploads\/models\/[a-f0-9]{64}\.glb$/).optional().nullable(),
  model3dName: z.string().trim().min(1).max(200).optional().nullable(),
  model3dSource: z.enum(["kicad", "upload"]).optional().nullable(),
});

const optionalCatalogTextSchema = (max: number) => z.string()
  .trim()
  .max(max)
  .transform(value => value || null)
  .optional()
  .nullable();

function isCatalogUrl(value: string) {
  if (!value) return true;
  if (value.startsWith("/uploads/")) return value.length > "/uploads/".length;

  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

const optionalCatalogUrlSchema = z.string()
  .trim()
  .max(2_000)
  .refine(
    isCatalogUrl,
    "Must be an HTTP(S) URL or a managed upload path",
  )
  .transform(value => value || null)
  .optional()
  .nullable();

const createToolBodySchema = insertToolSchema.extend({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  manufacturer: optionalCatalogTextSchema(200),
  modelNumber: optionalCatalogTextSchema(200),
  productUrl: optionalCatalogUrlSchema,
  imageUrl: optionalCatalogUrlSchema,
  quantity: z.coerce.number().int().min(1).optional(),
  location: optionalCatalogTextSchema(300),
  capabilities: optionalCatalogTextSchema(4_000),
  notes: optionalCatalogTextSchema(4_000),
}).strict();

const updateToolBodySchema = createToolBodySchema.partial().refine(
  updates => Object.keys(updates).length > 0,
  { message: "At least one tool field is required" },
);

const optionalAdapterEndpointTypeSchema = z.preprocess(
  value => typeof value === "string" ? value.trim() || null : value,
  adapterEndpointTypeSchema.nullable().optional(),
);

const adapterEndpointFieldsSchema = z.object({
  endpointA: z.string().nullable().optional(),
  endpointAType: adapterEndpointTypeSchema.nullable().optional(),
  endpointB: z.string().nullable().optional(),
  endpointBType: adapterEndpointTypeSchema.nullable().optional(),
}).superRefine((value, context) => {
  const hasEndpointA = Boolean(value.endpointA);
  const hasEndpointB = Boolean(value.endpointB);
  if (hasEndpointA !== hasEndpointB) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Endpoint A and endpoint B must either both be provided or both be blank",
      path: [hasEndpointA ? "endpointB" : "endpointA"],
    });
  }
  if (!hasEndpointA && (value.endpointAType || value.endpointBType)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Endpoint icon types require both endpoint labels",
      path: [value.endpointAType ? "endpointAType" : "endpointBType"],
    });
  }
});

const adapterBodyFieldsSchema = insertAdapterSchema.extend({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  manufacturer: optionalCatalogTextSchema(200),
  modelNumber: optionalCatalogTextSchema(200),
  productUrl: optionalCatalogUrlSchema,
  imageUrl: optionalCatalogUrlSchema,
  endpointA: optionalCatalogTextSchema(200),
  endpointAType: optionalAdapterEndpointTypeSchema,
  endpointB: optionalCatalogTextSchema(200),
  endpointBType: optionalAdapterEndpointTypeSchema,
  quantity: z.coerce.number().int().min(1).optional(),
  location: optionalCatalogTextSchema(300),
  compatibility: optionalCatalogTextSchema(4_000),
  notes: optionalCatalogTextSchema(4_000),
}).strict();

const createAdapterBodySchema = adapterBodyFieldsSchema.superRefine((value, context) => {
  const result = adapterEndpointFieldsSchema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue(issue);
  }
});

const updateAdapterBodySchema = adapterBodyFieldsSchema.partial().refine(
  updates => Object.keys(updates).length > 0,
  { message: "At least one adapter field is required" },
);

function normalizeLegacyAdapterEndpointType(value: string | null | undefined) {
  const parsed = adapterEndpointTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const adapterSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
});

const createComponentBookBodySchema = insertComponentBookSchema.extend({
  name: z.string().trim().min(1).max(200),
  manufacturer: optionalCatalogTextSchema(200),
  packageSize: optionalCatalogTextSchema(100),
  productUrl: optionalCatalogUrlSchema,
  imageUrl: optionalCatalogUrlSchema,
  description: optionalCatalogTextSchema(4_000),
  notes: optionalCatalogTextSchema(4_000),
}).strict();

const updateComponentBookBodySchema = createComponentBookBodySchema.partial().refine(
  updates => Object.keys(updates).length > 0,
  { message: "At least one component book field is required" },
);

const componentBookItemBodySchema = insertComponentBookItemSchema.omit({
  bookId: true,
}).extend({
  name: z.string().trim().min(1).max(200),
  category: optionalCatalogTextSchema(100),
  partNumber: optionalCatalogTextSchema(200),
  value: optionalCatalogTextSchema(200),
  packageSize: optionalCatalogTextSchema(100),
  quantity: z.coerce.number().int().min(0).optional().nullable(),
  notes: optionalCatalogTextSchema(4_000),
}).strict();

const updateComponentBookItemBodySchema = componentBookItemBodySchema.partial().refine(
  updates => Object.keys(updates).length > 0,
  { message: "At least one component book item field is required" },
);

const componentBookSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
});

const downloadAssetSchema = z.object({
  url: z.string().url(),
});

function getCategoryId(category?: string) {
  if (!category) return undefined;
  return categoryIds[category.toLowerCase()] ?? categoryIds.other;
}

function normalizeComponentBody<T extends { category?: string; categoryId?: number }>(data: T) {
  const { category, ...componentData } = data;
  const categoryId = data.categoryId ?? getCategoryId(category);
  return categoryId === undefined ? componentData : { ...componentData, categoryId };
}

function componentRotationMatchesModel(
  rotation: unknown,
  modelUrl: string | null | undefined,
) {
  return rotation === null || rotation === undefined ||
    parseComponentModelRotationForModel(rotation, modelUrl) !== null;
}

function getAssetType(value: string): AssetType | null {
  if (value === "datasheet" || value === "photo") return value;
  return null;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function getHtmlAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "") : undefined;
}

function resolveHtmlUrl(rawValue: string | undefined, baseUrl: URL) {
  const value = decodeHtmlEntities(rawValue || "").trim();
  if (!value || /^(data|javascript|mailto|tel):/i.test(value)) return null;

  try {
    const resolved = new URL(value, baseUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function getFirstSrcsetUrl(srcset: string | undefined) {
  return srcset?.split(",")[0]?.trim().split(/\s+/)[0];
}

function scoreImageCandidate(url: string, tag: string, baseScore: number) {
  let score = baseScore;
  const haystack = `${url} ${tag}`.toLowerCase();
  if (/(component|product|outline|photo|pinout|package|3d|documents)/.test(haystack)) score += 20;
  if (/(logo|favicon|icon|banner|sprite|ad-|ads|tracking|rohs|nopb)/.test(haystack)) score -= 35;

  const widthValue = getHtmlAttribute(tag, "width")?.replace(/[^\d]/g, "");
  const width = widthValue ? Number(widthValue) : 0;
  if (width >= 200) score += 10;
  if (width > 0 && width < 80) score -= 15;

  return score;
}

function getHtmlTags(html: string, regex: RegExp) {
  const tags: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    tags.push(match[0]);
  }

  return tags;
}

function extractImageCandidates(html: string, baseUrl: URL) {
  const byUrl = new Map<string, ImageCandidate>();
  let order = 0;

  const addCandidate = (rawUrl: string | undefined, score: number, tag = "") => {
    const url = resolveHtmlUrl(rawUrl, baseUrl);
    if (!url) return;

    const candidateScore = scoreImageCandidate(url, tag, score);
    const existing = byUrl.get(url);
    if (!existing || candidateScore > existing.score) {
      byUrl.set(url, { url, score: candidateScore, order: existing?.order ?? order++ });
    }
  };

  for (const tag of getHtmlTags(html, /<meta\b[^>]*>/gi)) {
    const key = (getHtmlAttribute(tag, "property") || getHtmlAttribute(tag, "name") || "").toLowerCase();
    if (key === "og:image" || key === "og:image:url" || key === "twitter:image" || key === "twitter:image:src") {
      addCandidate(getHtmlAttribute(tag, "content"), 100, tag);
    }
  }

  for (const tag of getHtmlTags(html, /<link\b[^>]*>/gi)) {
    const rel = (getHtmlAttribute(tag, "rel") || "").toLowerCase();
    if (rel.includes("image_src")) {
      addCandidate(getHtmlAttribute(tag, "href"), 90, tag);
    }
  }

  for (const tag of getHtmlTags(html, /<a\b[^>]*>/gi)) {
    addCandidate(getHtmlAttribute(tag, "data-source"), 80, tag);
    addCandidate(getHtmlAttribute(tag, "href"), 60, tag);
  }

  for (const tag of getHtmlTags(html, /<img\b[^>]*>/gi)) {
    addCandidate(
      getHtmlAttribute(tag, "src") ||
        getHtmlAttribute(tag, "data-src") ||
        getHtmlAttribute(tag, "data-lazy-src") ||
        getFirstSrcsetUrl(getHtmlAttribute(tag, "srcset")),
      70,
      tag,
    );
  }

  return Array.from(byUrl.values()).sort((left, right) => right.score - left.score || left.order - right.order);
}

async function fetchRemoteAsset(urlString: string): Promise<FetchedAsset> {
  const url = new URL(urlString);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https links are supported");
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_ASSET_SIZE) {
    throw new Error("Downloaded file exceeds the 10MB limit");
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_ASSET_SIZE) {
    throw new Error("Downloaded file exceeds the 10MB limit");
  }

  const contentType = response.headers.get("content-type") || "";
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType,
    url: new URL(response.url || url.toString()),
  };
}

function saveDownloadedAsset(assetType: AssetType, asset: FetchedAsset) {
  const extension =
    getExtensionFromBuffer(asset.buffer) ||
    getKnownExtensionFromContentType(asset.contentType) ||
    getAllowedExtensionFromUrl(asset.url, assetType) ||
    (assetType === "datasheet" ? ".pdf" : ".img");
  const filename = buildAssetFilename(extension);
  const subdir = uploadSubdirs[assetType];
  const fullPath = path.join(uploadsRoot, subdir, filename);

  fs.writeFileSync(fullPath, asset.buffer);

  return `/uploads/${subdir}/${filename}`;
}

async function downloadRemoteAsset(assetType: AssetType, urlString: string) {
  const asset = await fetchRemoteAsset(urlString);
  const assetKind = getAssetKind(asset.buffer, asset.contentType);

  if (assetType === "datasheet") {
    if (assetKind !== "pdf") {
      throw new Error("Datasheet links must point to a downloadable PDF file");
    }

    return saveDownloadedAsset(assetType, asset);
  }

  if (assetKind === "image") {
    return saveDownloadedAsset(assetType, asset);
  }

  if (assetKind === "html") {
    const html = asset.buffer.toString("utf8");
    const candidates = extractImageCandidates(html, asset.url).slice(0, 15);

    for (const candidate of candidates) {
      try {
        const candidateAsset = await fetchRemoteAsset(candidate.url);
        if (getAssetKind(candidateAsset.buffer, candidateAsset.contentType) === "image") {
          return saveDownloadedAsset(assetType, candidateAsset);
        }
      } catch {
        // Keep trying lower-ranked image candidates from the page.
      }
    }

    throw new Error("Photo link opened a web page, but no downloadable image was found");
  }

  throw new Error("Photo links must point to an image file or a page with a downloadable image");
}

function saveCaseImage(buffer: Buffer) {
  const extension = getExtensionFromBuffer(buffer);
  if (!caseImageExtensions.has(extension)) {
    throw new Error("Case images must be JPEG, PNG, or WebP files");
  }

  const assetId = crypto.createHash("sha256").update(buffer).digest("hex");
  const filename = `${assetId}${extension}`;
  const fullPath = path.join(uploadsRoot, caseImageSubdir, filename);

  try {
    fs.writeFileSync(fullPath, buffer, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
  }

  return `/uploads/${caseImageSubdir}/${filename}`;
}

function getCaseImagePath(imageUrl: string) {
  const parsed = caseImageUrlSchema.safeParse(imageUrl);
  if (!parsed.success) return null;

  const filename = path.posix.basename(parsed.data);
  const fullPath = path.resolve(uploadsRoot, caseImageSubdir, filename);
  const imageDirectory = path.resolve(uploadsRoot, caseImageSubdir);
  if (path.dirname(fullPath) !== imageDirectory) return null;

  return fullPath;
}

async function removeCaseImageIfUnreferenced(imageUrl: string | null | undefined) {
  if (!imageUrl) return;

  const cases = await storage.getCases();
  const isReferenced = cases.some(case_ =>
    case_.closedImageUrl === imageUrl || case_.openImageUrl === imageUrl
  );
  if (isReferenced) return;

  const fullPath = getCaseImagePath(imageUrl);
  if (fullPath) fs.rmSync(fullPath, { force: true });
}

function getModelAssetId(modelUrl: string | null | undefined) {
  return getManagedModelAssetId(modelUrl);
}

function getCaseModelFields(part: "top" | "bottom") {
  return part === "top"
    ? {
        url: "topModel3dUrl" as const,
        name: "topModel3dName" as const,
        source: "topModel3dSource" as const,
        calibration: "topModel3dCalibration" as const,
      }
    : {
        url: "bottomModel3dUrl" as const,
        name: "bottomModel3dName" as const,
        source: "bottomModel3dSource" as const,
        calibration: "bottomModel3dCalibration" as const,
      };
}

ensureUploadDirectories();

export async function registerRoutes(app: Express): Promise<Server> {
  const modelAssetService = new ModelAssetService({ uploadsRoot, storage });

  // Launchers use this identity endpoint to distinguish Component Catalog
  // from an unrelated application that happens to occupy the preferred port.
  app.get("/api/health", (req, res) => {
    res.json({
      app: "component-catalog",
      status: "ok",
      port: req.socket.localPort ?? null,
      ...getRuntimeAccessMetadata(),
    });
  });

  // Model replacement, removal, calibration and stale-asset cleanup form one
  // logical operation per case. Serializing them prevents concurrent requests
  // from applying calibration to a superseded half or leaking an intermediate
  // upload in this process.
  const caseModelOperationTails = new Map<number, Promise<void>>();
  const acquireCaseModelOperation = async (caseId: number) => {
    const previous = caseModelOperationTails.get(caseId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>(resolve => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    caseModelOperationTails.set(caseId, tail);
    await previous.catch(() => undefined);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (caseModelOperationTails.get(caseId) === tail) {
        caseModelOperationTails.delete(caseId);
      }
    };
  };
  const defaultCaseModels = await loadDefaultCaseModelCatalog(modelAssetService);
  if (
    isCompleteDefaultCaseModelCatalog(defaultCaseModels) &&
    await storage.needsDefaultCaseModelBackfill()
  ) {
    await seedMissingDefaultCaseModels(storage, defaultCaseModels);
    await storage.completeDefaultCaseModelBackfill();
  }
  const caseModelUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, modelAssetService.tempRoot),
      filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.glb`),
    }),
    limits: { files: 1, fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
      callback(null, path.extname(file.originalname).toLowerCase() === ".glb");
    },
  });

  // Serve uploaded files
  app.use('/uploads', express.static(uploadsRoot, {
    setHeaders: (res, filePath) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      const extension = path.extname(filePath).toLowerCase();
      if (extension === ".glb") {
        res.setHeader("Content-Type", "model/gltf-binary");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Disposition", "inline");
        return;
      }
      if (extension !== ".img") return;

      try {
        const fd = fs.openSync(filePath, "r");
        const buffer = Buffer.alloc(512);
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
        fs.closeSync(fd);

        const mimeType = getImageMimeTypeFromBuffer(buffer.subarray(0, bytesRead));
        if (mimeType) {
          res.setHeader("Content-Type", mimeType);
        }
      } catch {
        // Leave Express' default static headers in place if probing fails.
      }
    },
  }));

  registerModelAssetRoutes(app, modelAssetService);

  app.post("/api/cases/:id/models/:part", (req, res) => {
    caseModelUpload.single("model")(req, res, async uploadError => {
      if (uploadError) {
        const status = uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({
          message: status === 413 ? "Case GLB files must be 50 MB or smaller" : "Invalid case GLB upload",
        });
      }

      let uploadedAssetId: string | null = null;
      let releaseCaseModelOperation: (() => void) | null = null;
      try {
        const id = z.coerce.number().int().positive().parse(req.params.id);
        const part = caseModelPartSchema.parse(req.params.part);
        releaseCaseModelOperation = await acquireCaseModelOperation(id);
        const existingCase = await storage.getCase(id);
        if (!existingCase) {
          if (req.file?.path) fs.rmSync(req.file.path, { force: true });
          return res.status(404).json({ message: "Case not found" });
        }
        if (!req.file) {
          return res.status(400).json({ message: "Choose a GLB file for this case half" });
        }

        const asset = await modelAssetService.importUpload(req.file);
        uploadedAssetId = asset.assetId;
        const fields = getCaseModelFields(part);
        const previousUrl = existingCase[fields.url];
        const previousAssetId = getModelAssetId(previousUrl);
        const updates: Partial<InsertCase> = {
          [fields.url]: asset.url,
          [fields.name]: asset.name,
          [fields.source]: asset.source,
          ...(previousAssetId !== asset.assetId ? { [fields.calibration]: null } : {}),
        };
        const updatedCase = await storage.updateCase(id, updates);
        if (!updatedCase) {
          await modelAssetService.deleteAsset(asset.assetId);
          return res.status(404).json({ message: "Case not found" });
        }
        if (previousAssetId && previousAssetId !== asset.assetId) {
          try {
            await modelAssetService.deleteAsset(previousAssetId);
          } catch {
            // The new association is saved; stale unreferenced asset cleanup is best-effort.
          }
        }

        res.json(updatedCase);
      } catch (error) {
        if (req.file?.path) fs.rmSync(req.file.path, { force: true });
        if (uploadedAssetId) await modelAssetService.deleteAsset(uploadedAssetId);
        const status = error instanceof ZodError ? 400 : 400;
        res.status(status).json({
          message: error instanceof Error ? error.message : "Failed to save case GLB",
        });
      } finally {
        releaseCaseModelOperation?.();
      }
    });
  });

  app.delete("/api/cases/:id/models/:part", async (req, res) => {
    let releaseCaseModelOperation: (() => void) | null = null;
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const part = caseModelPartSchema.parse(req.params.part);
      releaseCaseModelOperation = await acquireCaseModelOperation(id);
      const existingCase = await storage.getCase(id);
      if (!existingCase) return res.status(404).json({ message: "Case not found" });

      const fields = getCaseModelFields(part);
      const previousAssetId = getModelAssetId(existingCase[fields.url]);
      const updates: Partial<InsertCase> = {
        [fields.url]: null,
        [fields.name]: null,
        [fields.source]: null,
        [fields.calibration]: null,
      };
      const updatedCase = await storage.updateCase(id, updates);
      if (!updatedCase) return res.status(404).json({ message: "Case not found" });

      if (previousAssetId) {
        try {
          await modelAssetService.deleteAsset(previousAssetId);
        } catch {
          // Clearing the case association is authoritative; cleanup is best-effort.
        }
      }
      res.json(updatedCase);
    } catch (error) {
      res.status(400).json({
        message: error instanceof Error ? error.message : "Failed to remove case GLB",
      });
    } finally {
      releaseCaseModelOperation?.();
    }
  });

  app.put("/api/cases/:id/models/:part/calibration", async (req, res) => {
    let releaseCaseModelOperation: (() => void) | null = null;
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const part = caseModelPartSchema.parse(req.params.part);
      releaseCaseModelOperation = await acquireCaseModelOperation(id);
      const calibration = caseModelCalibrationSchema.parse(req.body);
      const result = await storage.setCaseModelCalibration(
        id,
        part,
        calibration.assetId,
        calibration,
      );
      if (result.status === "not_found") {
        return res.status(404).json({ message: "Case not found" });
      }
      if (result.status === "asset_mismatch") {
        return res.status(409).json({
          message: `Calibration asset does not match an active managed ${part} GLB`,
        });
      }
      res.json(result.case);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid case model calibration", errors: error.errors });
      }
      res.status(400).json({ message: "Failed to save case model calibration" });
    } finally {
      releaseCaseModelOperation?.();
    }
  });

  app.delete("/api/cases/:id/models/:part/calibration", async (req, res) => {
    let releaseCaseModelOperation: (() => void) | null = null;
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const part = caseModelPartSchema.parse(req.params.part);
      releaseCaseModelOperation = await acquireCaseModelOperation(id);
      const { assetId } = deleteCaseModelCalibrationSchema.parse(req.body);
      const result = await storage.setCaseModelCalibration(id, part, assetId, null);
      if (result.status === "not_found") {
        return res.status(404).json({ message: "Case not found" });
      }
      if (result.status === "asset_mismatch") {
        return res.status(409).json({
          message: `Calibration asset does not match an active managed ${part} GLB`,
        });
      }
      res.json(result.case);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid case model calibration request", errors: error.errors });
      }
      res.status(400).json({ message: "Failed to remove case model calibration" });
    } finally {
      releaseCaseModelOperation?.();
    }
  });

  app.post("/api/cases/:id/images/:variant", receiveCaseImage, async (req, res) => {
    let uploadedUrl: string | null = null;

    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const variant = caseImageVariantSchema.parse(req.params.variant);
      const existingCase = await storage.getCase(id);
      if (!existingCase) {
        return res.status(404).json({ message: "Case not found" });
      }
      if (!req.file) {
        return res.status(400).json({ message: "No case image uploaded" });
      }

      uploadedUrl = saveCaseImage(req.file.buffer);
      const field = variant === "closed" ? "closedImageUrl" : "openImageUrl";
      const previousUrl = existingCase[field];
      const updatedCase = await storage.updateCase(id, { [field]: uploadedUrl });
      if (!updatedCase) {
        await removeCaseImageIfUnreferenced(uploadedUrl);
        return res.status(404).json({ message: "Case not found" });
      }

      if (previousUrl !== uploadedUrl) {
        await removeCaseImageIfUnreferenced(previousUrl);
      }

      res.json(updatedCase);
    } catch (error) {
      if (uploadedUrl) await removeCaseImageIfUnreferenced(uploadedUrl);

      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid case image request" });
      }

      res.status(400).json({
        message: error instanceof Error ? error.message : "Failed to upload case image",
      });
    }
  });

  app.delete("/api/cases/:id/images/:variant", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const variant = caseImageVariantSchema.parse(req.params.variant);
      const existingCase = await storage.getCase(id);
      if (!existingCase) {
        return res.status(404).json({ message: "Case not found" });
      }

      const field = variant === "closed" ? "closedImageUrl" : "openImageUrl";
      const previousUrl = existingCase[field];
      const updatedCase = await storage.updateCase(id, { [field]: null });
      if (!updatedCase) {
        return res.status(404).json({ message: "Case not found" });
      }

      await removeCaseImageIfUnreferenced(previousUrl);
      res.json(updatedCase);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid case image request" });
      }

      res.status(400).json({ message: "Failed to remove case image" });
    }
  });

  // Get all cases
  app.get("/api/cases", async (req, res) => {
    try {
      const cases = await storage.getCases();
      res.json(cases);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch cases" });
    }
  });

  // Get case with compartments and components
  app.get("/api/cases/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const case_ = await storage.getCaseWithCompartments(id);

      if (!case_) {
        return res.status(404).json({ message: "Case not found" });
      }

      res.json(case_);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch case" });
    }
  });

  // Reorder cases
  app.patch("/api/cases/reorder", async (req, res) => {
    try {
      const { caseIds } = reorderCasesBodySchema.parse(req.body);
      const reorderedCases = await storage.reorderCases(caseIds);

      if (!reorderedCases) {
        return res.status(400).json({
          message: "Case order must include every reorderable case exactly once",
        });
      }

      res.json(reorderedCases);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid case order",
          errors: error.errors,
        });
      }

      res.status(400).json({ message: "Invalid case order" });
    }
  });

  // Create new case
  app.post("/api/cases", async (req, res) => {
    try {
      const requestData = createCaseBodySchema.parse(req.body);
      const model = requestData.model ?? getFallbackCaseModel(
        requestData.rows!,
        requestData.cols!,
        requestData.hasBottom ?? false,
      );
      const defaults = getCaseDefaults(model);
      const rows = requestData.rows ?? defaults.rows;
      const cols = requestData.cols ?? defaults.cols;
      const hasBottom = requestData.hasBottom ?? defaults.hasBottom;
      let layoutGeometry = null;
      if (model.startsWith("CUSTOM-")) {
        layoutGeometry = requestData.layoutGeometry
          ? parseCustomCaseLayout(requestData.layoutGeometry, { rows, cols, hasBottom })
          : createUniformCustomCaseLayout(rows, cols, hasBottom);
      } else if (requestData.layoutGeometry) {
        throw new Error("Custom layout geometry is only valid for custom cases");
      }
      const validatedData = insertCaseSchema.parse({
        ...requestData,
        model,
        rows,
        cols,
        hasBottom,
        layoutGeometry,
      });
      const createdCase = await storage.createCase(validatedData);
      const case_ = await ensureDefaultCaseModels(storage, createdCase, defaultCaseModels);
      res.status(201).json(case_);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid case data",
          errors: error.errors,
        });
      }

      res.status(400).json({ message: "Invalid case data" });
    }
  });

  app.patch("/api/cases/:id/layout", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const existingCase = await storage.getCase(id);
      if (!existingCase) return res.status(404).json({ message: "Case not found" });
      if (!existingCase.model.startsWith("CUSTOM-")) {
        return res.status(400).json({ message: "Only custom cases have adjustable layouts" });
      }

      const body = z.object({ layoutGeometry: z.unknown() }).strict().parse(req.body);
      const layoutGeometry = parseCustomCaseLayout(body.layoutGeometry, {
        rows: existingCase.rows,
        cols: existingCase.cols,
        hasBottom: Boolean(existingCase.hasBottom),
      });
      const case_ = await storage.updateCase(id, { layoutGeometry });
      if (!case_) return res.status(404).json({ message: "Case not found" });
      res.json(case_);
    } catch (error) {
      res.status(400).json({
        message: error instanceof Error ? error.message : "Invalid custom case layout",
      });
    }
  });

  // Update case
  app.patch("/api/cases/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = updateCaseBodySchema.parse(req.body);
      const case_ = await storage.updateCase(id, updates);

      if (!case_) {
        return res.status(404).json({ message: "Case not found" });
      }

      res.json(case_);
    } catch (error) {
      res.status(400).json({ message: "Invalid update data" });
    }
  });

  // Delete case
  app.delete("/api/cases/:id", async (req, res) => {
    let releaseCaseModelOperation: (() => void) | null = null;
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      releaseCaseModelOperation = await acquireCaseModelOperation(id);
      const existingCase = await storage.getCase(id);
      const existingCaseDetails = await storage.getCaseWithCompartments(id);
      const modelAssetIds = new Set<string>();
      for (const modelUrl of [
        existingCase?.topModel3dUrl,
        existingCase?.bottomModel3dUrl,
        ...(existingCaseDetails?.compartments.map(compartment => compartment.component?.model3dUrl) ?? []),
      ]) {
        const assetId = getModelAssetId(modelUrl);
        if (assetId) modelAssetIds.add(assetId);
      }
      const success = await storage.deleteCase(id);

      if (!success) {
        return res.status(404).json({ message: "Case not found" });
      }

      await removeCaseImageIfUnreferenced(existingCase?.closedImageUrl);
      await removeCaseImageIfUnreferenced(existingCase?.openImageUrl);
      for (const assetId of Array.from(modelAssetIds)) {
        try {
          await modelAssetService.deleteAsset(assetId);
        } catch {
          // The case deletion is authoritative; asset cleanup is reference-aware and best-effort.
        }
      }
      res.json({ message: "Case deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete case" });
    } finally {
      releaseCaseModelOperation?.();
    }
  });

  // Get all components
  app.get("/api/components", async (req, res) => {
    try {
      const components = await storage.getComponents();
      res.json(components);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch components" });
    }
  });

  // Search components
  app.get("/api/components/search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ message: "Search query is required" });
      }

      const components = await storage.searchComponents(query);
      res.json(components);
    } catch (error) {
      res.status(500).json({ message: "Failed to search components" });
    }
  });

  // Create component
  app.post("/api/components", async (req, res) => {
    try {
      const requestData = createComponentBodySchema.parse(req.body);
      if (!componentRotationMatchesModel(requestData.model3dRotation, requestData.model3dUrl)) {
        return res.status(400).json({
          message: "Component model rotation must match the active GLB asset",
        });
      }
      const validatedData = insertComponentSchema.parse(normalizeComponentBody(requestData));
      const component = await storage.createComponent(validatedData);
      res.status(201).json(component);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid component data",
          errors: error.errors,
        });
      }

      res.status(400).json({ message: "Invalid component data" });
    }
  });

  // Update component
  app.patch("/api/components/:id", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const existingComponent = await storage.getComponent(id);
      if (!existingComponent) {
        return res.status(404).json({ message: "Component not found" });
      }
      const requestData = updateComponentBodySchema.parse(req.body);
      const nextModelUrl = Object.prototype.hasOwnProperty.call(requestData, "model3dUrl")
        ? requestData.model3dUrl
        : existingComponent.model3dUrl;
      if (!componentRotationMatchesModel(requestData.model3dRotation, nextModelUrl)) {
        return res.status(400).json({
          message: "Component model rotation must match the active GLB asset",
        });
      }
      const updates = insertComponentSchema.partial().parse(normalizeComponentBody(requestData));
      const component = await storage.updateComponent(id, updates);

      if (!component) {
        return res.status(404).json({ message: "Component not found" });
      }

      res.json(component);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid update data",
          errors: error.errors,
        });
      }

      res.status(400).json({ message: "Invalid update data" });
    }
  });

  // Delete component
  app.delete("/api/components/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const success = await storage.deleteComponent(id);

      if (!success) {
        return res.status(404).json({ message: "Component not found" });
      }

      res.json({ message: "Component deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete component" });
    }
  });

  // Get all tools
  app.get("/api/tools", async (_req, res) => {
    try {
      const tools = await storage.getTools();
      res.json(tools);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch tools" });
    }
  });

  // Create tool
  app.post("/api/tools", async (req, res) => {
    try {
      const tool = await storage.createTool(createToolBodySchema.parse(req.body));
      res.status(201).json(tool);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid tool data",
          errors: error.errors,
        });
      }

      console.error("Failed to create tool", error);
      res.status(500).json({ message: "Failed to create tool" });
    }
  });

  // Update tool
  app.patch("/api/tools/:id", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const tool = await storage.updateTool(id, updateToolBodySchema.parse(req.body));
      if (!tool) {
        return res.status(404).json({ message: "Tool not found" });
      }

      res.json(tool);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid update data",
          errors: error.errors,
        });
      }

      console.error("Failed to update tool", error);
      res.status(500).json({ message: "Failed to update tool" });
    }
  });

  // Delete tool
  app.delete("/api/tools/:id", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const success = await storage.deleteTool(id);
      if (!success) {
        return res.status(404).json({ message: "Tool not found" });
      }

      res.json({ message: "Tool deleted successfully" });
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid tool ID" });
      }

      res.status(500).json({ message: "Failed to delete tool" });
    }
  });

  app.get("/api/adapters/search", async (req, res) => {
    try {
      const { q } = adapterSearchQuerySchema.parse(req.query);
      res.json(await storage.searchAdapters(q));
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid adapter search",
          errors: error.errors,
        });
      }

      console.error("Failed to search adapters", error);
      res.status(500).json({ message: "Failed to search adapters" });
    }
  });

  app.get("/api/adapters", async (_req, res) => {
    try {
      res.json(await storage.getAdapters());
    } catch (error) {
      console.error("Failed to fetch adapters", error);
      res.status(500).json({ message: "Failed to fetch adapters" });
    }
  });

  app.post("/api/adapters", async (req, res) => {
    try {
      const adapter = await storage.createAdapter(createAdapterBodySchema.parse(req.body));
      res.status(201).json(adapter);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid adapter data",
          errors: error.errors,
        });
      }

      console.error("Failed to create adapter", error);
      res.status(500).json({ message: "Failed to create adapter" });
    }
  });

  app.patch("/api/adapters/:id", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const updates = updateAdapterBodySchema.parse(req.body);
      const existingAdapter = await storage.getAdapter(id);
      if (!existingAdapter) return res.status(404).json({ message: "Adapter not found" });

      const endpointKeys = ["endpointA", "endpointAType", "endpointB", "endpointBType"] as const;
      const updatesEndpoints = endpointKeys.some(key =>
        Object.prototype.hasOwnProperty.call(updates, key)
      );
      if (updatesEndpoints) {
        const nextEndpointA = Object.prototype.hasOwnProperty.call(updates, "endpointA")
          ? updates.endpointA
          : existingAdapter.endpointA;
        const nextEndpointB = Object.prototype.hasOwnProperty.call(updates, "endpointB")
          ? updates.endpointB
          : existingAdapter.endpointB;
        const nextEndpointAType = normalizeLegacyAdapterEndpointType(
          Object.prototype.hasOwnProperty.call(updates, "endpointAType")
            ? updates.endpointAType
            : existingAdapter.endpointAType,
        );
        const nextEndpointBType = normalizeLegacyAdapterEndpointType(
          Object.prototype.hasOwnProperty.call(updates, "endpointBType")
            ? updates.endpointBType
            : existingAdapter.endpointBType,
        );

        adapterEndpointFieldsSchema.parse({
          endpointA: nextEndpointA,
          endpointAType: nextEndpointAType,
          endpointB: nextEndpointB,
          endpointBType: nextEndpointBType,
        });
        updates.endpointAType = nextEndpointA ? nextEndpointAType : null;
        updates.endpointBType = nextEndpointB ? nextEndpointBType : null;
      }

      const adapter = await storage.updateAdapter(id, updates);
      if (!adapter) return res.status(404).json({ message: "Adapter not found" });
      res.json(adapter);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid adapter update",
          errors: error.errors,
        });
      }

      console.error("Failed to update adapter", error);
      res.status(500).json({ message: "Failed to update adapter" });
    }
  });

  app.delete("/api/adapters/:id", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      if (!await storage.deleteAdapter(id)) {
        return res.status(404).json({ message: "Adapter not found" });
      }
      res.json({ message: "Adapter deleted successfully" });
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid adapter ID" });
      }

      console.error("Failed to delete adapter", error);
      res.status(500).json({ message: "Failed to delete adapter" });
    }
  });

  // Search component book contents. Keep this route separate from physical
  // components so callers can clearly label a result as being in a book.
  app.get("/api/component-book-items/search", async (req, res) => {
    try {
      const { q } = componentBookSearchQuerySchema.parse(req.query);
      res.json(await storage.searchComponentBookItems(q));
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid component book search",
          errors: error.errors,
        });
      }

      console.error("Failed to search component books", error);
      res.status(500).json({ message: "Failed to search component books" });
    }
  });

  app.get("/api/component-books", async (_req, res) => {
    try {
      res.json(await storage.getComponentBooks());
    } catch (error) {
      console.error("Failed to fetch component books", error);
      res.status(500).json({ message: "Failed to fetch component books" });
    }
  });

  app.get("/api/component-books/:id", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const book = await storage.getComponentBook(id);
      if (!book) return res.status(404).json({ message: "Component book not found" });
      res.json(book);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid component book ID" });
      }

      console.error("Failed to fetch component book", error);
      res.status(500).json({ message: "Failed to fetch component book" });
    }
  });

  app.post("/api/component-books", async (req, res) => {
    try {
      const book = await storage.createComponentBook(createComponentBookBodySchema.parse(req.body));
      res.status(201).json(book);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid component book data",
          errors: error.errors,
        });
      }

      console.error("Failed to create component book", error);
      res.status(500).json({ message: "Failed to create component book" });
    }
  });

  app.patch("/api/component-books/:id", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const book = await storage.updateComponentBook(
        id,
        updateComponentBookBodySchema.parse(req.body),
      );
      if (!book) return res.status(404).json({ message: "Component book not found" });
      res.json(book);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid component book update",
          errors: error.errors,
        });
      }

      console.error("Failed to update component book", error);
      res.status(500).json({ message: "Failed to update component book" });
    }
  });

  app.delete("/api/component-books/:id", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      if (!await storage.deleteComponentBook(id)) {
        return res.status(404).json({ message: "Component book not found" });
      }
      res.json({ message: "Component book deleted successfully" });
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid component book ID" });
      }

      console.error("Failed to delete component book", error);
      res.status(500).json({ message: "Failed to delete component book" });
    }
  });

  app.get("/api/component-books/:id/items", async (req, res) => {
    try {
      const bookId = z.coerce.number().int().positive().parse(req.params.id);
      if (!await storage.getComponentBook(bookId)) {
        return res.status(404).json({ message: "Component book not found" });
      }
      res.json(await storage.getComponentBookItems(bookId));
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid component book ID" });
      }

      console.error("Failed to fetch component book items", error);
      res.status(500).json({ message: "Failed to fetch component book items" });
    }
  });

  app.post("/api/component-books/:id/items", async (req, res) => {
    try {
      const bookId = z.coerce.number().int().positive().parse(req.params.id);
      if (!await storage.getComponentBook(bookId)) {
        return res.status(404).json({ message: "Component book not found" });
      }
      const item = await storage.createComponentBookItem({
        ...componentBookItemBodySchema.parse(req.body),
        bookId,
      });
      res.status(201).json(item);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid component book item data",
          errors: error.errors,
        });
      }

      console.error("Failed to create component book item", error);
      res.status(500).json({ message: "Failed to create component book item" });
    }
  });

  app.patch("/api/component-book-items/:id", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const item = await storage.updateComponentBookItem(
        id,
        updateComponentBookItemBodySchema.parse(req.body),
      );
      if (!item) return res.status(404).json({ message: "Component book item not found" });
      res.json(item);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid component book item update",
          errors: error.errors,
        });
      }

      console.error("Failed to update component book item", error);
      res.status(500).json({ message: "Failed to update component book item" });
    }
  });

  app.delete("/api/component-book-items/:id", async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      if (!await storage.deleteComponentBookItem(id)) {
        return res.status(404).json({ message: "Component book item not found" });
      }
      res.json({ message: "Component book item deleted successfully" });
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid component book item ID" });
      }

      console.error("Failed to delete component book item", error);
      res.status(500).json({ message: "Failed to delete component book item" });
    }
  });

  // Checkout component
  app.post("/api/components/:id/checkout", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { checkedOutBy } = req.body;

      if (!checkedOutBy) {
        return res.status(400).json({ message: "checkedOutBy field is required" });
      }

      const component = await storage.updateComponent(id, {
        checkedOut: true,
        checkedOutBy,
        checkedOutDate: new Date()
      });

      if (!component) {
        return res.status(404).json({ message: "Component not found" });
      }

      res.json(component);
    } catch (error) {
      res.status(500).json({ message: "Failed to checkout component" });
    }
  });

  // Return component
  app.post("/api/components/:id/return", async (req, res) => {
    try {
      const id = parseInt(req.params.id);

      const component = await storage.updateComponent(id, {
        checkedOut: false,
        checkedOutBy: null,
        checkedOutDate: null
      });

      if (!component) {
        return res.status(404).json({ message: "Component not found" });
      }

      res.json(component);
    } catch (error) {
      res.status(500).json({ message: "Failed to return component" });
    }
  });

  // Move component to different compartment (drag and drop)
  app.post("/api/components/:id/move", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { targetCompartmentId, insertPosition } = req.body;

      if (!targetCompartmentId) {
        return res.status(400).json({ message: "targetCompartmentId is required" });
      }

      // Get the component to move
      const component = await storage.getComponent(id);
      if (!component) {
        return res.status(404).json({ message: "Component not found" });
      }

      // If inserting into a position with existing component, we need to shift others
      if (insertPosition !== undefined) {
        await storage.shiftComponentsInCase(targetCompartmentId, insertPosition);
      }

      // Update the component's compartment
      const updatedComponent = await storage.updateComponent(id, {
        compartmentId: targetCompartmentId
      });

      res.json(updatedComponent);
    } catch (error) {
      res.status(500).json({ message: "Failed to move component" });
    }
  });

  // Upload a BOM, match it against inventory, and generate a printable location report.
  app.post("/api/bom/locate", bomUpload.single("bom"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No BOM file uploaded" });
      }

      const cases = await storage.getCases();
      const caseDetails = (await Promise.all(
        cases.map(case_ => storage.getCaseWithCompartments(case_.id)),
      )).filter((case_): case_ is CaseWithCompartments => Boolean(case_));

      const report = createBomLocationReport({
        sourceFile: req.file.originalname || "bom",
        buffer: req.file.buffer,
        cases: caseDetails,
      });
      const pdfUrl = saveReportPdf(renderBomLocationReportPdf(report));
      report.pdfUrl = pdfUrl;
      report.ai = await analyzeBomWithHuggingFace(report);
      const htmlUrl = saveReportHtml(renderBomLocationReportHtml(report));
      report.htmlUrl = htmlUrl;

      res.json({
        ...report,
        pdfUrl,
        htmlUrl,
      });
    } catch (error) {
      res.status(400).json({
        message: error instanceof Error ? error.message : "Failed to process BOM",
      });
    }
  });

  // Upload datasheet
  app.post("/api/upload/datasheet", upload.single('datasheet'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const fileUrl = `/uploads/${uploadSubdirs.datasheet}/${req.file.filename}`;
      res.json({ url: fileUrl });
    } catch (error) {
      res.status(500).json({ message: "Failed to upload file" });
    }
  });

  // Upload photo
  app.post("/api/upload/photo", upload.single('photo'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const fileUrl = `/uploads/${uploadSubdirs.photo}/${req.file.filename}`;
      res.json({ url: fileUrl });
    } catch (error) {
      res.status(500).json({ message: "Failed to upload file" });
    }
  });

  // Download remote datasheet/photo link into local uploads storage
  app.post("/api/download/:type", async (req, res) => {
    try {
      const assetType = getAssetType(req.params.type);
      if (!assetType) {
        return res.status(400).json({ message: "Invalid asset type" });
      }

      const { url } = downloadAssetSchema.parse(req.body);
      const fileUrl = await downloadRemoteAsset(assetType, url);
      res.json({ url: fileUrl });
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          message: "Invalid download data",
          errors: error.errors,
        });
      }

      res.status(400).json({
        message: error instanceof Error ? error.message : "Failed to download file",
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
