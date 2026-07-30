import assert from "node:assert/strict";
import {
  evaluateLanRequest,
  getRuntimeAccessMetadata,
  isLanAccessEnabled,
  isRfc1918Ipv4,
  loadLanAccessConfig,
  type LanRequestDetails,
} from "../server/lan-access";

for (const address of [
  "10.0.0.1",
  "10.255.255.254",
  "172.16.0.1",
  "172.31.255.254",
  "192.168.0.1",
  "192.168.255.254",
]) {
  assert.equal(isRfc1918Ipv4(address), true, `${address} should be accepted as RFC1918`);
}

for (const address of [
  "9.255.255.255",
  "11.0.0.1",
  "172.15.255.255",
  "172.32.0.1",
  "192.167.1.1",
  "192.169.1.1",
  "127.0.0.1",
  "169.254.1.1",
  "0.0.0.0",
  "::1",
  "not-an-ip",
]) {
  assert.equal(isRfc1918Ipv4(address), false, `${address} should be rejected`);
}

assert.equal(isLanAccessEnabled({ COMPONENT_CATALOG_LAN_ACCESS: " TRUE " }), true);
assert.equal(loadLanAccessConfig({}), null);
assert.deepEqual(
  getRuntimeAccessMetadata({
    COMPONENT_CATALOG_LAN_ACCESS: "true",
    HOST: "192.168.50.48",
    NODE_ENV: "production",
  }),
  { bindHost: "192.168.50.48", lanAccess: true, productionMode: true },
);
assert.throws(
  () => loadLanAccessConfig({ COMPONENT_CATALOG_LAN_ACCESS: "true", HOST: "0.0.0.0" }),
  /specific private IPv4 address/,
);
assert.throws(
  () => loadLanAccessConfig({ COMPONENT_CATALOG_LAN_ACCESS: "true", HOST: "127.0.0.1" }),
  /specific private IPv4 address/,
);
assert.throws(
  () => loadLanAccessConfig({ COMPONENT_CATALOG_LAN_ACCESS: "true", HOST: "8.8.8.8" }),
  /specific private IPv4 address/,
);

const config = loadLanAccessConfig({
  COMPONENT_CATALOG_LAN_ACCESS: "true",
  HOST: "192.168.50.48",
});
assert(config);

const request = (overrides: Partial<LanRequestDetails> = {}): LanRequestDetails => ({
  method: "GET",
  hostHeader: "192.168.50.48:5000",
  originHeader: undefined,
  fetchSiteHeader: "same-origin",
  localPort: 5000,
  ...overrides,
});

assert.equal(evaluateLanRequest(config, request()), null);
assert.equal(evaluateLanRequest(config, request({ method: "POST" })), null, "CLI-style requests remain usable");
assert.equal(
  evaluateLanRequest(config, request({ method: "PATCH", originHeader: "http://192.168.50.48:5000" })),
  null,
);
assert.equal(evaluateLanRequest(config, request({ hostHeader: undefined })), "invalid-host");
assert.equal(evaluateLanRequest(config, request({ hostHeader: "192.168.50.48:5001" })), "invalid-host");
assert.equal(evaluateLanRequest(config, request({ hostHeader: "192.168.50.48" })), "invalid-host");
assert.equal(
  evaluateLanRequest(config, request({ hostHeader: "192.168.50.48", localPort: 80 })),
  null,
  "HTTP's default port may be omitted from the Host header",
);
assert.equal(evaluateLanRequest(config, request({ hostHeader: "192.168.50.49:5000" })), "invalid-host");
assert.equal(evaluateLanRequest(config, request({ hostHeader: "192.168.50.48:5000.evil.test" })), "invalid-host");
assert.equal(
  evaluateLanRequest(config, request({ originHeader: "http://evil.test:5000" })),
  "cross-origin",
);
assert.equal(
  evaluateLanRequest(config, request({ method: "POST", originHeader: "https://192.168.50.48:5000" })),
  "cross-origin",
);
assert.equal(
  evaluateLanRequest(config, request({ fetchSiteHeader: "cross-site" })),
  "cross-site",
  "Cross-site navigation and subresource requests should be rejected even when they use GET",
);

console.log("LAN access verification passed.");
