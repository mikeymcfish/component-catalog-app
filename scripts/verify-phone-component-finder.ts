import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import type { Adapter, Tool } from "../shared/schema";
import type { IStorage } from "../server/storage";
import { searchInventory } from "../server/inventory-search";
import {
  createComponentFinderMcpServer,
  createPhoneAccessHttpServer,
  loadPhoneMcpRuntimeConfig,
  type PhoneMcpRuntimeConfig,
} from "../server/phone-mcp-server";
import { verifyPhoneAccessToken } from "../server/phone-auth";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRejects(callback: () => Promise<unknown>, message: string) {
  let rejected = false;
  try {
    await callback();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

async function closeHttpServer(server: HttpServer) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function seedSearchFixture(storage: IStorage) {
  const case_ = await storage.createCase({
    name: "Diode Case",
    model: "LAYOUT-2x1-BOTH",
    rows: 1,
    cols: 2,
    hasBottom: true,
    description: "Verification case",
  });
  const details = await storage.getCaseWithCompartments(case_.id);
  assert(details?.compartments.length === 4, "Fixture case should create top and bottom compartments");
  const compartment = (position: string, layer: string) => {
    const found = details.compartments.find(item => item.position === position && item.layer === layer);
    assert(found, `Missing fixture compartment ${position} ${layer}`);
    return found;
  };

  await storage.createComponent({
    compartmentId: compartment("A1", "top").id,
    name: "SS14",
    categoryId: 4,
    quantity: 2,
    minQuantity: 1,
  });
  await storage.createComponent({
    compartmentId: compartment("A1", "bottom").id,
    name: "ss14",
    categoryId: 4,
    quantity: 3,
    minQuantity: 1,
  });
  await storage.createComponent({
    compartmentId: compartment("A2", "bottom").id,
    name: "SRV054CTP",
    categoryId: 4,
    packageSize: "SOT-23-6",
    quantity: 4,
    minQuantity: 1,
    notes: "ESD Protection Diodes / TVS Diodes 5 Volts ESD Protection Device",
  });
  await storage.createComponent({
    compartmentId: compartment("A2", "top").id,
    name: "BZX84C5V1",
    categoryId: 4,
    packageSize: "SOT-23-3",
    quantity: 0,
    minQuantity: 1,
    notes: "Zener Diode 5.1 V 350 mW",
  });

  const inactive = await storage.createCase({
    name: "Inactive Case",
    model: "LAYOUT-1x1-TOP",
    rows: 1,
    cols: 1,
    hasBottom: false,
  });
  const inactiveDetails = await storage.getCaseWithCompartments(inactive.id);
  assert(inactiveDetails?.compartments[0], "Inactive fixture needs a compartment");
  await storage.createComponent({
    compartmentId: inactiveDetails.compartments[0].id,
    name: "HIDDEN-DIODE",
    categoryId: 4,
    quantity: 10,
  });
  await storage.updateCase(inactive.id, { isActive: false } as never);
}

async function seedToolFixture(storage: IStorage) {
  await storage.createTool({
    name: "Bench Oscilloscope",
    category: "Oscilloscope",
    manufacturer: "Rigol",
    modelNumber: "DS1054Z",
    productUrl: "https://example.com/tools/ds1054z",
    imageUrl: "https://example.com/images/ds1054z.jpg",
    quantity: 1,
    location: "Electronics bench",
    capabilities: "4 channels, 50 MHz bandwidth, serial protocol decoding",
    notes: "Includes four switchable 1x/10x passive probes",
  });
  await storage.createTool({
    name: "Multimeter Probes",
    category: "Probe",
    manufacturer: null,
    modelNumber: null,
    quantity: 3,
    location: null,
    capabilities: "Fine-tip voltage and continuity probing",
    notes: null,
  });
}

async function seedAdapterFixture(storage: IStorage) {
  await storage.createAdapter({
    name: "Cortex Debug to SWD Adapter",
    category: "Programming Adapter",
    manufacturer: "Adapter Labs",
    modelNumber: "SWD-10-6",
    productUrl: "https://example.com/adapters/swd-10-6",
    imageUrl: "https://example.com/images/swd-10-6.jpg",
    endpointA: "10-pin 1.27 mm Cortex Debug header",
    endpointAType: "debug-header",
    endpointB: "6-pin 2.54 mm SWD header",
    endpointBType: "pin-header",
    quantity: 2,
    location: "Adapter drawer",
    compatibility: "10-pin 1.27 mm Cortex Debug to 6-pin 2.54 mm SWD; 1.8-5 V targets",
    notes: "Pin 1 is marked by the red stripe",
  });
}

async function seedComponentBookFixture(storage: IStorage) {
  const book = await storage.createComponentBook({
    name: "0603 Resistor Sample Book",
    manufacturer: "Sample Book Co.",
    packageSize: "0603",
    productUrl: "https://example.com/books/0603-resistors",
    imageUrl: "https://example.com/images/0603-resistors.jpg",
    description: "Assorted surface-mount resistor values",
    notes: "Owned sample book; entries are not stored in loose component cases",
  });
  await storage.createComponentBookItem({
    bookId: book.id,
    name: "10 kΩ resistor",
    category: "Resistors",
    partNumber: null,
    value: "10 kΩ",
    packageSize: "0603",
    quantity: 50,
    notes: "1% tolerance",
  });
}

async function verifySearchContract(storage: IStorage) {
  await seedSearchFixture(storage);

  const exact = await searchInventory(storage, { need: "Where is SS14?" });
  assert(exact.totalMatches === 1, "Exact lookup should return one grouped part");
  assert(exact.candidates[0].matchQuality === "exact", "Exact lookup should be marked exact");
  assert(exact.candidates[0].totalQuantity === 5, "Duplicate stock should aggregate quantity");
  assert(exact.candidates[0].locations.length === 2, "Duplicate stock should preserve both locations");
  assert(exact.candidates[0].locations.some(location => location.layer === "bottom"), "Bottom layer should be preserved");

  const vague = await searchInventory(storage, { need: "I need a diode" });
  assert(vague.needsClarification, "Category-only lookup should request clarification");
  assert(vague.clarificationAxes[0].includes("rectification"), "Diode clarification should distinguish function");
  assert(!vague.candidates.some(candidate => candidate.name === "HIDDEN-DIODE"), "Inactive case stock must be excluded");

  const esd = await searchInventory(storage, { need: "5 V ESD protection" });
  assert(esd.candidates[0]?.name === "SRV054CTP", "Application search should rank the grounded 5 V ESD part first");
  assert(esd.candidates[0].matchQuality === "strong", "Fully matched application search should be strong");

  const packageMatch = await searchInventory(storage, { need: "Zener diode", packageSize: "SOT-23-3" });
  assert(packageMatch.candidates.length === 1 && packageMatch.candidates[0].name === "BZX84C5V1", "Package constraint should filter results");
  assert(packageMatch.candidates[0].stockStatus === "out", "Zero quantity should be marked out");

  const impossible = await searchInventory(storage, { need: "100 V 5 A diode" });
  assert(impossible.candidates.length === 0, "Unsatisfied explicit ratings should return no match");
}

class AuthenticatedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  readonly toolSecuritySchemeNames = new Set<string>();

  constructor(private readonly inner: InMemoryTransport, private readonly authInfo: AuthInfo) {}

  async start() {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = error => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => {
      const response = message as JSONRPCMessage & {
        result?: { tools?: Array<{ name?: string; securitySchemes?: unknown }> };
      };
      for (const tool of response.result?.tools ?? []) {
        if (tool.name && Array.isArray(tool.securitySchemes)) {
          this.toolSecuritySchemeNames.add(tool.name);
        }
      }
      this.onmessage?.(message, extra);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    await this.inner.send(message, { ...options, authInfo: this.authInfo });
  }

  async close() {
    await this.inner.close();
  }
}

async function verifyMcpProtocol(storage: IStorage, config: PhoneMcpRuntimeConfig) {
  const [rawClientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createComponentFinderMcpServer(storage, config);
  const authInfo: AuthInfo = {
    token: "verified-test-token",
    clientId: "verification-client",
    scopes: [config.auth.requiredScope],
    resource: new URL(config.auth.resource),
  };
  const client = new Client({ name: "verification-client", version: "1.0.0" });
  const inventoryBefore = JSON.stringify(await storage.getComponents());
  const toolsBefore = JSON.stringify(await storage.getTools());
  const adaptersBefore = JSON.stringify(await storage.getAdapters());
  const componentBooksBefore = JSON.stringify(await storage.getComponentBooks());
  await server.connect(serverTransport);
  const authenticatedTransport = new AuthenticatedTransport(rawClientTransport, authInfo);
  await client.connect(authenticatedTransport);
  const tools = await client.listTools();
  const advertisedNames = new Set(tools.tools.map(tool => tool.name));
  assert(
    tools.tools.length === 4 &&
      advertisedNames.has("search_inventory") &&
      advertisedNames.has("search_component_books") &&
      advertisedNames.has("list_tools") &&
      advertisedNames.has("list_adapters"),
    "MCP should advertise inventory, component-book, tool, and adapter searches",
  );
  const listToolsDescriptor = tools.tools.find(tool => tool.name === "list_tools");
  const listToolsOutputSchema = JSON.stringify(listToolsDescriptor?.outputSchema);
  assert(listToolsOutputSchema.includes("productUrl"), "list_tools output schema should declare productUrl");
  assert(listToolsOutputSchema.includes("imageUrl"), "list_tools output schema should declare imageUrl");
  const listAdaptersDescriptor = tools.tools.find(tool => tool.name === "list_adapters");
  const listAdaptersOutputSchema = JSON.stringify(listAdaptersDescriptor?.outputSchema);
  assert(listAdaptersOutputSchema.includes("compatibility"), "list_adapters output schema should declare compatibility");
  assert(listAdaptersOutputSchema.includes("productUrl"), "list_adapters output schema should declare productUrl");
  assert(listAdaptersOutputSchema.includes("imageUrl"), "list_adapters output schema should declare imageUrl");
  assert(listAdaptersOutputSchema.includes("endpointA"), "list_adapters output schema should declare endpoint A");
  assert(listAdaptersOutputSchema.includes("endpointB"), "list_adapters output schema should declare endpoint B");
  for (const tool of tools.tools) {
    assert(tool.annotations?.readOnlyHint === true, `${tool.name} must be declared read-only`);
    assert(tool.annotations?.destructiveHint === false, `${tool.name} must be declared non-destructive`);
    assert(
      authenticatedTransport.toolSecuritySchemeNames.has(tool.name),
      `${tool.name} should advertise OAuth security schemes on the wire`,
    );
    assert(Array.isArray(tool._meta?.securitySchemes), `${tool.name} should advertise OAuth compatibility metadata`);
  }
  const result = await client.callTool({ name: "search_inventory", arguments: { need: "SS14" } });
  assert(!result.isError, "Authenticated MCP search should succeed");
  assert((result.structuredContent as { totalMatches?: number } | undefined)?.totalMatches === 1, "MCP search should return structured inventory results");

  const componentBookResult = await client.callTool({
    name: "search_component_books",
    arguments: { query: "10 kΩ" },
  });
  assert(!componentBookResult.isError, "Authenticated MCP component-book search should succeed");
  const searchedBooks = componentBookResult.structuredContent as {
    totalMatches?: number;
    matches?: Array<{
      name?: string;
      packageSize?: string | null;
      quantity?: number | null;
      stockContext?: string;
      isLooseInventory?: boolean;
      book?: { name?: string; manufacturer?: string | null; packageSize?: string | null };
    }>;
  } | undefined;
  assert(searchedBooks?.totalMatches === 1, "MCP component-book search should report grounded match count");
  const bookMatch = searchedBooks.matches?.[0];
  assert(bookMatch?.name === "10 kΩ resistor", "MCP component-book search should return the matching entry");
  assert(bookMatch.packageSize === "0603", "MCP component-book matches should include item package");
  assert(bookMatch.quantity === 50, "MCP component-book matches should include recorded quantity");
  assert(bookMatch.book?.name === "0603 Resistor Sample Book", "MCP component-book matches should identify the owned book");
  assert(bookMatch.book.packageSize === "0603", "MCP component-book matches should include book package metadata");
  assert(bookMatch.book.manufacturer === "Sample Book Co.", "MCP component-book matches should include book manufacturer");
  assert(bookMatch.stockContext === "component_book_contents", "MCP should label book contents separately from loose stock");
  assert(bookMatch.isLooseInventory === false, "MCP should never represent a component-book match as loose inventory");

  const listResult = await client.callTool({ name: "list_tools", arguments: {} });
  assert(!listResult.isError, "Authenticated MCP tool listing should succeed");
  const listed = listResult.structuredContent as { totalTools?: number; tools?: Tool[] } | undefined;
  assert(listed?.totalTools === 2, "MCP list_tools should report the total number of owned tools");
  assert(Array.isArray(listed.tools) && listed.tools.length === 2, "MCP list_tools should return every owned tool");
  const listedOscilloscope = listed.tools.find(tool => tool.name === "Bench Oscilloscope");
  assert(listedOscilloscope, "MCP list_tools should return the seeded oscilloscope");
  assert(listedOscilloscope.category === "Oscilloscope", "MCP tools should include category");
  assert(listedOscilloscope.manufacturer === "Rigol", "MCP tools should include manufacturer");
  assert(listedOscilloscope.modelNumber === "DS1054Z", "MCP tools should include model number");
  assert(listedOscilloscope.productUrl?.endsWith("/ds1054z"), "MCP tools should include product URLs");
  assert(listedOscilloscope.imageUrl?.endsWith("/ds1054z.jpg"), "MCP tools should include image URLs");
  assert(listedOscilloscope.quantity === 1, "MCP tools should include quantity");
  assert(listedOscilloscope.location === "Electronics bench", "MCP tools should include location");
  assert(listedOscilloscope.capabilities?.includes("50 MHz"), "MCP tools should include capabilities");
  assert(listedOscilloscope.notes?.includes("passive probes"), "MCP tools should include notes");
  for (const listedTool of listed.tools) {
    for (const field of [
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
    ] as const) {
      assert(Object.prototype.hasOwnProperty.call(listedTool, field), `MCP tool results should include ${field}`);
    }
  }

  const adapterListResult = await client.callTool({ name: "list_adapters", arguments: {} });
  assert(!adapterListResult.isError, "Authenticated MCP adapter listing should succeed");
  const listedAdapters = adapterListResult.structuredContent as {
    totalAdapters?: number;
    adapters?: Adapter[];
  } | undefined;
  assert(listedAdapters?.totalAdapters === 1, "MCP list_adapters should report the total number of owned adapters");
  assert(Array.isArray(listedAdapters.adapters) && listedAdapters.adapters.length === 1, "MCP list_adapters should return every owned adapter");
  const listedAdapter = listedAdapters.adapters[0];
  assert(listedAdapter.name === "Cortex Debug to SWD Adapter", "MCP list_adapters should return the seeded adapter");
  assert(listedAdapter.category === "Programming Adapter", "MCP adapters should include category");
  assert(listedAdapter.manufacturer === "Adapter Labs", "MCP adapters should include manufacturer");
  assert(listedAdapter.modelNumber === "SWD-10-6", "MCP adapters should include model number");
  assert(listedAdapter.productUrl?.endsWith("/swd-10-6"), "MCP adapters should include product URLs");
  assert(listedAdapter.imageUrl?.endsWith("/swd-10-6.jpg"), "MCP adapters should include image URLs");
  assert(listedAdapter.endpointA === "10-pin 1.27 mm Cortex Debug header", "MCP adapters should include endpoint A");
  assert(listedAdapter.endpointAType === "debug-header", "MCP adapters should include endpoint A type");
  assert(listedAdapter.endpointB === "6-pin 2.54 mm SWD header", "MCP adapters should include endpoint B");
  assert(listedAdapter.endpointBType === "pin-header", "MCP adapters should include endpoint B type");
  assert(listedAdapter.quantity === 2, "MCP adapters should include quantity");
  assert(listedAdapter.location === "Adapter drawer", "MCP adapters should include location");
  assert(listedAdapter.compatibility?.includes("1.8-5 V"), "MCP adapters should include compatibility");
  assert(listedAdapter.notes?.includes("red stripe"), "MCP adapters should include notes");
  for (const field of [
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
  ] as const) {
    assert(Object.prototype.hasOwnProperty.call(listedAdapter, field), `MCP adapter results should include ${field}`);
  }
  assert(JSON.stringify(await storage.getComponents()) === inventoryBefore, "MCP search must not mutate inventory");
  assert(JSON.stringify(await storage.getTools()) === toolsBefore, "MCP list_tools must not mutate tools");
  assert(JSON.stringify(await storage.getAdapters()) === adaptersBefore, "MCP list_adapters must not mutate adapters");
  assert(JSON.stringify(await storage.getComponentBooks()) === componentBooksBefore, "MCP component-book search must not mutate books or entries");
  await client.close();
  await server.close();

  const [unauthClientTransport, unauthServerTransport] = InMemoryTransport.createLinkedPair();
  const unauthServer = createComponentFinderMcpServer(storage, config);
  const unauthClient = new Client({ name: "unauth-client", version: "1.0.0" });
  await unauthServer.connect(unauthServerTransport);
  await unauthClient.connect(unauthClientTransport);
  const denied = await unauthClient.callTool({ name: "search_inventory", arguments: { need: "SS14" } });
  assert(denied.isError, "Unauthenticated MCP search should be denied");
  assert(Array.isArray(denied._meta?.["mcp/www_authenticate"]), "Denied MCP search should return an OAuth challenge");
  const deniedToolList = await unauthClient.callTool({ name: "list_tools", arguments: {} });
  assert(deniedToolList.isError, "Unauthenticated MCP tool listing should be denied");
  assert(
    Array.isArray(deniedToolList._meta?.["mcp/www_authenticate"]),
    "Denied MCP tool listing should return an OAuth challenge",
  );
  const deniedAdapterList = await unauthClient.callTool({ name: "list_adapters", arguments: {} });
  assert(deniedAdapterList.isError, "Unauthenticated MCP adapter listing should be denied");
  assert(
    Array.isArray(deniedAdapterList._meta?.["mcp/www_authenticate"]),
    "Denied MCP adapter listing should return an OAuth challenge",
  );
  const deniedBookSearch = await unauthClient.callTool({
    name: "search_component_books",
    arguments: { query: "0603" },
  });
  assert(deniedBookSearch.isError, "Unauthenticated MCP component-book search should be denied");
  assert(
    Array.isArray(deniedBookSearch._meta?.["mcp/www_authenticate"]),
    "Denied MCP component-book search should return an OAuth challenge",
  );
  await unauthClient.close();
  await unauthServer.close();
}

async function verifyJwt(config: PhoneMcpRuntimeConfig) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "verification-key";
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";
  const getKey = createLocalJWKSet({ keys: [publicJwk] });
  const now = Math.floor(Date.now() / 1000);
  const sign = (scope: string, audience = config.auth.audience, expiration = now + 300) => new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "verification-key" })
    .setIssuer(config.auth.issuer.endsWith("/") ? config.auth.issuer : `${config.auth.issuer}/`)
    .setAudience(audience)
    .setSubject("verification-user")
    .setIssuedAt(now)
    .setExpirationTime(expiration)
    .sign(privateKey);

  const valid = await verifyPhoneAccessToken(await sign(config.auth.requiredScope), config.auth, getKey);
  assert(valid.scopes.includes(config.auth.requiredScope), "Valid JWT should expose the read scope");
  await assertRejects(async () => verifyPhoneAccessToken(await sign("other:scope"), config.auth, getKey), "Missing scope must be rejected");
  await assertRejects(async () => verifyPhoneAccessToken(await sign(config.auth.requiredScope, "wrong-audience"), config.auth, getKey), "Wrong audience must be rejected");
  await assertRejects(async () => verifyPhoneAccessToken(await sign(config.auth.requiredScope, config.auth.audience, now - 1), config.auth, getKey), "Expired token must be rejected");
}

async function verifyHttpBoundary(storage: IStorage, config: PhoneMcpRuntimeConfig) {
  const server = createPhoneAccessHttpServer(storage, { ...config, port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === "object", "HTTP verification server should have an address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${baseUrl}/health`);
  assert(health.status === 200 && (await health.json() as { oauth?: string }).oauth === "required", "Health route should be public and report OAuth");
  const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  const metadataBody = await metadata.json() as { resource?: string; scopes_supported?: string[] };
  assert(metadataBody.resource === config.auth.resource, "Protected resource metadata should advertise the MCP resource");
  assert(metadataBody.scopes_supported?.includes(config.auth.requiredScope), "Protected resource metadata should advertise read scope");
  assert((await fetch(`${baseUrl}/api/components`)).status === 404, "Phone server must not expose catalog REST APIs");
  assert((await fetch(`${baseUrl}/api/tools`)).status === 404, "Phone server must not expose the tools REST API");
  assert((await fetch(`${baseUrl}/api/adapters`)).status === 404, "Phone server must not expose the adapters REST API");
  await closeHttpServer(server);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "component-catalog-phone-test-"));
  const previousStorageFile = process.env.STORAGE_FILE;
  process.env.STORAGE_FILE = path.join(tempDir, "module-storage.json");
  try {
    const [{ MemStorage, JsonFileStorage }] = await Promise.all([import("../server/storage")]);
    await verifySearchContract(new MemStorage(false));
    await verifySearchContract(new JsonFileStorage(path.join(tempDir, "storage.json")));

    const config = loadPhoneMcpRuntimeConfig({
      MCP_PUBLIC_URL: "https://component-catalog-example.ngrok.app",
      AUTH0_ISSUER: "https://component-catalog-example.us.auth0.com/",
      AUTH0_AUDIENCE: "https://component-catalog-example.ngrok.app/mcp",
      AUTH0_SCOPE: "inventory:read",
      PHONE_ACCESS_HOST: "127.0.0.1",
      PHONE_ACCESS_PORT: "5002",
    });
    const protocolStorage = new MemStorage(false);
    await seedSearchFixture(protocolStorage);
    await seedToolFixture(protocolStorage);
    await seedAdapterFixture(protocolStorage);
    await seedComponentBookFixture(protocolStorage);
    await verifyMcpProtocol(protocolStorage, config);
    await verifyJwt(config);
    await verifyHttpBoundary(protocolStorage, config);
    await assertRejects(
      async () => loadPhoneMcpRuntimeConfig({ MCP_PUBLIC_URL: "http://insecure.test", AUTH0_ISSUER: "https://issuer.test" }),
      "Non-HTTPS public URL must be rejected",
    );
  } finally {
    if (previousStorageFile === undefined) delete process.env.STORAGE_FILE;
    else process.env.STORAGE_FILE = previousStorageFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log("phone component finder verification passed");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
