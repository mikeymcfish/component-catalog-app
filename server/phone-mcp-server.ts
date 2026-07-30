import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type JSONRPCMessage,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { COMPONENT_CATEGORY_VALUES } from "@shared/component-categories";
import type { IStorage } from "./storage";
import { searchInventory } from "./inventory-search";
import { formatHttpUrl } from "./port-fallback";
import {
  getBearerToken,
  verifyPhoneAccessToken,
  type PhoneAccessAuthConfig,
} from "./phone-auth";

dotenv.config({
  path: process.env.PHONE_ACCESS_ENV_FILE || path.join(process.cwd(), ".env.phone.local"),
  quiet: true,
});

const SEARCH_INVENTORY_TOOL_NAME = "search_inventory";
const SEARCH_COMPONENT_BOOKS_TOOL_NAME = "search_component_books";
const LIST_TOOLS_TOOL_NAME = "list_tools";
const LIST_ADAPTERS_TOOL_NAME = "list_adapters";
const MCP_TOOL_NAMES = new Set([
  SEARCH_INVENTORY_TOOL_NAME,
  SEARCH_COMPONENT_BOOKS_TOOL_NAME,
  LIST_TOOLS_TOOL_NAME,
  LIST_ADAPTERS_TOOL_NAME,
]);
const DEFAULT_SCOPE = "inventory:read";
const DEFAULT_PORT = 5002;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const SERVER_INSTRUCTIONS = [
  "Always call search_inventory before claiming a part is owned or giving its location.",
  "Call search_component_books alongside search_inventory when finding or choosing a component so matches inside owned sample books are surfaced.",
  "Always call list_tools before suggesting a debugging or measurement technique or claiming test equipment is available.",
  "Call list_adapters before suggesting a connector, cable, programming-header, level-shifting, protocol-conversion, or power-adaptation workaround.",
  "If several candidates differ materially, ask the smallest useful clarification based on the returned clarificationAxes; for diodes, establish function and then voltage/current or package.",
  "Recommend only when catalog evidence supports a clear choice. Prefer stockStatus available over low or out.",
  "Ground debugging advice in the returned tool capabilities, quantities, locations, and notes; never invent an unlisted capability, probe, adapter, or instrument.",
  "Use adapter endpointA and endpointB as physical interfaces only; the displayed A-to-B relationship never proves signal direction, pin mapping, level shifting, or protocol conversion.",
  "Ground adapter advice in the returned endpoints, compatibility, quantities, locations, and notes; never assume an unlisted connector gender, pinout, protocol, voltage/current limit, cable, or supported target.",
  "Never invent specifications, recommend an unreturned part, or present a broad match as certain.",
  "A search_component_books match means the part is included in an owned component book; it is not loose inventory and has no case or compartment location. Clearly name the book, package, and recorded included quantity, and keep it separate from loose stock.",
  "For a resolved loose-component lookup, answer concisely with part name, case, compartment, and top/bottom layer.",
  "For debugging advice, name the returned tool and explain the measurement or technique using only its recorded capabilities and accessories.",
].join(" ");

const searchInputSchema = z.object({
  need: z.string().trim().min(1).max(300),
  category: z.enum(COMPONENT_CATEGORY_VALUES).optional(),
  packageSize: z.string().trim().min(1).max(80).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const componentBookSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(300),
  limit: z.number().int().min(1).max(100).optional(),
});

const candidateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "category", "packageSize", "notes", "totalQuantity", "stockStatus", "matchQuality", "locations"],
  properties: {
    name: { type: "string" },
    category: { type: "string" },
    packageSize: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
    totalQuantity: { type: "integer" },
    stockStatus: { type: "string", enum: ["available", "low", "out"] },
    matchQuality: { type: "string", enum: ["exact", "strong", "broad"] },
    locations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["caseName", "compartment", "layer", "quantity"],
        properties: {
          caseName: { type: "string" },
          compartment: { type: "string" },
          layer: { type: "string", enum: ["top", "bottom"] },
          quantity: { type: "integer" },
        },
      },
    },
  },
} as const;

const toolJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "category",
    "manufacturer",
    "modelNumber",
    "productUrl",
    "imageUrl",
    "quantity",
    "location",
    "capabilities",
    "notes",
  ],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    category: { type: "string" },
    manufacturer: { type: ["string", "null"] },
    modelNumber: { type: ["string", "null"] },
    productUrl: { type: ["string", "null"] },
    imageUrl: { type: ["string", "null"] },
    quantity: { type: "integer", minimum: 1 },
    location: { type: ["string", "null"] },
    capabilities: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
  },
} as const;

const adapterJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "category",
    "manufacturer",
    "modelNumber",
    "productUrl",
    "imageUrl",
    "endpointA",
    "endpointAType",
    "endpointB",
    "endpointBType",
    "quantity",
    "location",
    "compatibility",
    "notes",
  ],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    category: { type: "string" },
    manufacturer: { type: ["string", "null"] },
    modelNumber: { type: ["string", "null"] },
    productUrl: { type: ["string", "null"] },
    imageUrl: { type: ["string", "null"] },
    endpointA: { type: ["string", "null"], description: "Physical package or connector on side A; not a signal source" },
    endpointAType: { type: ["string", "null"], description: "Visual interface classification for endpoint A" },
    endpointB: { type: ["string", "null"], description: "Physical package or connector on side B; not a signal destination" },
    endpointBType: { type: ["string", "null"], description: "Visual interface classification for endpoint B" },
    quantity: { type: "integer", minimum: 1 },
    location: { type: ["string", "null"] },
    compatibility: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
  },
} as const;

const componentBookMatchJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "category",
    "partNumber",
    "value",
    "packageSize",
    "quantity",
    "notes",
    "stockContext",
    "isLooseInventory",
    "book",
  ],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    category: { type: ["string", "null"] },
    partNumber: { type: ["string", "null"] },
    value: { type: ["string", "null"] },
    packageSize: { type: ["string", "null"] },
    quantity: { type: ["integer", "null"], minimum: 0 },
    notes: { type: ["string", "null"] },
    stockContext: { type: "string", enum: ["component_book_contents"] },
    isLooseInventory: { type: "boolean" },
    book: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "manufacturer", "packageSize"],
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        manufacturer: { type: ["string", "null"] },
        packageSize: { type: ["string", "null"] },
      },
    },
  },
} as const;

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export interface PhoneMcpRuntimeConfig {
  host: string;
  port: number;
  publicUrl: string;
  auth: PhoneAccessAuthConfig;
}

export function loadPhoneMcpRuntimeConfig(env = process.env): PhoneMcpRuntimeConfig {
  const host = env.PHONE_ACCESS_HOST || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("PHONE_ACCESS_HOST must be a loopback address (127.0.0.1, ::1, or localhost)");
  }

  const port = Number(env.PHONE_ACCESS_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PHONE_ACCESS_PORT must be a valid TCP port");
  }

  const publicUrlValue = env.MCP_PUBLIC_URL?.trim();
  const issuer = env.AUTH0_ISSUER?.trim();
  if (!publicUrlValue) throw new Error("MCP_PUBLIC_URL is required when phone access is enabled");
  if (!issuer) throw new Error("AUTH0_ISSUER is required when phone access is enabled");

  const publicUrl = trimTrailingSlash(publicUrlValue);
  const parsedPublicUrl = new URL(publicUrl);
  if (parsedPublicUrl.protocol !== "https:") throw new Error("MCP_PUBLIC_URL must use HTTPS");
  const resource = `${publicUrl}/mcp`;
  const audience = env.AUTH0_AUDIENCE?.trim() || resource;
  const requiredScope = env.AUTH0_SCOPE?.trim() || DEFAULT_SCOPE;

  return {
    host,
    port,
    publicUrl,
    auth: { issuer, audience, requiredScope, resource },
  };
}

function authChallenge(config: Pick<PhoneMcpRuntimeConfig, "publicUrl" | "auth">) {
  return `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource", scope="${config.auth.requiredScope}"`;
}

function authRequiredResult(config: Pick<PhoneMcpRuntimeConfig, "publicUrl" | "auth">): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: "Authentication required. Link this app to continue." }],
    _meta: {
      "mcp/www_authenticate": [
        `${authChallenge(config)}, error="insufficient_scope", error_description="Sign in and grant inventory read access"`,
      ],
    },
  };
}

class ToolSecuritySchemeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(private readonly inner: Transport, private readonly requiredScope: string) {}

  get sessionId() {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string) {
    this.inner.setProtocolVersion?.(version);
  }

  async start() {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = error => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    // MCP SDK 1.x validates tools/list against the base MCP schema and strips the
    // Apps authentication extension. Restore the current ChatGPT descriptor
    // field on the wire while retaining the _meta mirror for older clients.
    const mutable = message as JSONRPCMessage & {
      result?: { tools?: Array<{ name?: string; securitySchemes?: unknown }> };
    };
    for (const tool of mutable.result?.tools ?? []) {
      if (tool.name && MCP_TOOL_NAMES.has(tool.name)) {
        tool.securitySchemes = [{ type: "oauth2", scopes: [this.requiredScope] }];
      }
    }
    await this.inner.send(message, options);
  }

  async close() {
    await this.inner.close();
  }
}

export function createComponentFinderMcpServer(
  storage: IStorage,
  config: Pick<PhoneMcpRuntimeConfig, "publicUrl" | "auth">,
) {
  const server = new Server(
    { name: "component-catalog-finder", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: SEARCH_INVENTORY_TOOL_NAME,
        title: "Search owned component inventory",
        description: "Use this whenever the user wants to find, choose, compare, or locate an electronic part they own. Searches only the private Component Catalog and returns grounded stock and physical locations. For vague needs, inspect needsClarification and clarificationAxes before recommending.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["need"],
          properties: {
            need: { type: "string", description: "The user's part name or application need in natural language." },
            category: { type: "string", enum: COMPONENT_CATEGORY_VALUES, description: "Known component category, when established." },
            packageSize: { type: "string", description: "Required package or footprint, when specified." },
            limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
          },
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query", "category", "totalMatches", "needsClarification", "clarificationAxes", "candidates"],
          properties: {
            query: { type: "string" },
            category: { type: ["string", "null"] },
            totalMatches: { type: "integer" },
            needsClarification: { type: "boolean" },
            clarificationAxes: { type: "array", items: { type: "string" } },
            candidates: { type: "array", items: candidateJsonSchema },
          },
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        securitySchemes: [{ type: "oauth2", scopes: [config.auth.requiredScope] }],
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: [config.auth.requiredScope] }],
        },
      },
      {
        name: SEARCH_COMPONENT_BOOKS_TOOL_NAME,
        title: "Search owned component books",
        description: "Use this alongside search_inventory when finding or choosing a component. Searches the recorded contents of owned sample books and returns the matching part plus its book name, package, and included quantity. Results are book contents, not loose case or compartment inventory.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", description: "Component name, value, part number, category, package, or book metadata to find." },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query", "totalMatches", "matches"],
          properties: {
            query: { type: "string" },
            totalMatches: { type: "integer", minimum: 0 },
            matches: { type: "array", items: componentBookMatchJsonSchema },
          },
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        securitySchemes: [{ type: "oauth2", scopes: [config.auth.requiredScope] }],
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: [config.auth.requiredScope] }],
        },
      },
      {
        name: LIST_TOOLS_TOOL_NAME,
        title: "List available electronics tools",
        description: "Use this before suggesting electronics debugging, measurement, rework, or programming techniques. Returns every owned instrument, probe, accessory, and tool with its grounded capabilities, quantity, location, product link, image, and notes.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["totalTools", "tools"],
          properties: {
            totalTools: { type: "integer", minimum: 0 },
            tools: { type: "array", items: toolJsonSchema },
          },
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        securitySchemes: [{ type: "oauth2", scopes: [config.auth.requiredScope] }],
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: [config.auth.requiredScope] }],
        },
      },
      {
        name: LIST_ADAPTERS_TOOL_NAME,
        title: "List available electronics adapters",
        description: "Use this before suggesting connector, cable, programming-header, level-shifting, protocol-conversion, or power-adaptation workarounds. Returns every owned adapter with explicit physical A/B endpoints, grounded compatibility, quantity, location, product link, image, and notes. Endpoints do not by themselves establish signal direction or active conversion.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["totalAdapters", "adapters"],
          properties: {
            totalAdapters: { type: "integer", minimum: 0 },
            adapters: { type: "array", items: adapterJsonSchema },
          },
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        securitySchemes: [{ type: "oauth2", scopes: [config.auth.requiredScope] }],
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: [config.auth.requiredScope] }],
        },
      },
    ],
  } as never));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!MCP_TOOL_NAMES.has(request.params.name)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      };
    }
    if (!extra.authInfo?.scopes.includes(config.auth.requiredScope)) {
      return authRequiredResult(config);
    }

    if (request.params.name === SEARCH_INVENTORY_TOOL_NAME) {
      const parsed = searchInputSchema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid search request: ${parsed.error.issues.map(issue => issue.message).join("; ")}` }],
        };
      }

      const result = await searchInventory(storage, parsed.data);
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    if (request.params.name === SEARCH_COMPONENT_BOOKS_TOOL_NAME) {
      const parsed = componentBookSearchInputSchema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid component book search request: ${parsed.error.issues.map(issue => issue.message).join("; ")}` }],
        };
      }

      const storedMatches = await storage.searchComponentBookItems(parsed.data.query);
      const matches = storedMatches.slice(0, parsed.data.limit ?? 20).map(item => ({
        id: item.id,
        name: item.name,
        category: item.category,
        partNumber: item.partNumber,
        value: item.value,
        packageSize: item.packageSize,
        quantity: item.quantity,
        notes: item.notes,
        stockContext: "component_book_contents" as const,
        isLooseInventory: false,
        book: {
          id: item.book.id,
          name: item.book.name,
          manufacturer: item.book.manufacturer,
          packageSize: item.book.packageSize,
        },
      }));
      const result = {
        query: parsed.data.query,
        totalMatches: storedMatches.length,
        matches,
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    if (request.params.name === LIST_ADAPTERS_TOOL_NAME) {
      const parsed = z.object({}).strict().safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid list adapters request: ${parsed.error.issues.map(issue => issue.message).join("; ")}` }],
        };
      }

      const adapters = await storage.getAdapters();
      const result = { totalAdapters: adapters.length, adapters };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    const parsed = z.object({}).strict().safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: "text", text: `Invalid list tools request: ${parsed.error.issues.map(issue => issue.message).join("; ")}` }],
      };
    }

    const tools = await storage.getTools();
    const result = { totalTools: tools.length, tools };
    return {
      structuredContent: result,
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  });

  return {
    connect: (transport: Transport) => server.connect(new ToolSecuritySchemeTransport(transport, config.auth.requiredScope)),
    close: () => server.close(),
  };
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
}

async function attachOptionalAuth(req: IncomingMessage & { auth?: Awaited<ReturnType<typeof verifyPhoneAccessToken>> }, config: PhoneMcpRuntimeConfig) {
  const token = getBearerToken(req.headers.authorization);
  if (!token) return;
  try {
    req.auth = await verifyPhoneAccessToken(token, config.auth);
  } catch {
    // Tool calls without a verified token receive an MCP OAuth challenge.
  }
}

export function createPhoneAccessHttpServer(storage: IStorage, config: PhoneMcpRuntimeConfig) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${config.host}:${config.port}`}`);
    const protectedMetadataPaths = new Set([
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", service: "component-catalog-phone-access", oauth: "required" });
      return;
    }

    if (req.method === "GET" && protectedMetadataPaths.has(url.pathname)) {
      sendJson(res, 200, {
        resource: config.auth.resource,
        authorization_servers: [config.auth.issuer],
        scopes_supported: [config.auth.requiredScope],
        resource_documentation: `${config.publicUrl}/health`,
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { message: "Not found" });
      return;
    }

    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (!req.method || !new Set(["POST", "GET", "DELETE"]).has(req.method)) {
      sendJson(res, 405, { message: "Method not allowed" }, { allow: "POST, GET, DELETE, OPTIONS" });
      return;
    }

    await attachOptionalAuth(req, config);
    const mcpServer = createComponentFinderMcpServer(storage, config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Phone access MCP request failed", error);
      if (!res.headersSent) sendJson(res, 500, { message: "Internal server error" });
    }
  });
}

export async function startPhoneAccessServer(storage: IStorage) {
  const config = loadPhoneMcpRuntimeConfig();
  const httpServer = createPhoneAccessHttpServer(storage, config);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  console.log(`phone access MCP serving on ${formatHttpUrl(config.host, address.port)}/mcp`);
  return httpServer;
}
