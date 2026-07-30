import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildPortCandidates,
  formatHttpUrl,
  listenWithPortFallback,
  parseTcpPort,
} from "../server/port-fallback";

function closeServer(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

const blocker = createServer((_req, res) => res.end("occupied"));
await new Promise<void>((resolve, reject) => {
  blocker.once("error", reject);
  blocker.listen(0, "127.0.0.1", resolve);
});

const occupiedPort = (blocker.address() as AddressInfo).port;
if (occupiedPort >= 65_533) {
  await closeServer(blocker);
  throw new Error("The operating system selected an unsuitable boundary port for this verification.");
}

const reservedPort = occupiedPort + 1;
assert.deepEqual(
  buildPortCandidates(occupiedPort, 2, new Set([reservedPort])),
  [occupiedPort, occupiedPort + 2],
  "Fallback candidates should skip the companion-service port",
);
assert.equal(parseTcpPort(undefined, 5000, "PORT"), 5000);
assert.throws(() => parseTcpPort("not-a-port", 5000, "PORT"), /PORT must be an integer/);
assert.equal(formatHttpUrl("127.0.0.1", 5000), "http://127.0.0.1:5000");
assert.equal(formatHttpUrl("::1", 5001), "http://[::1]:5001");

const appServer = createServer((_req, res) => res.end("catalog"));
try {
  const selectedPort = await listenWithPortFallback(appServer, {
    host: "127.0.0.1",
    preferredPort: occupiedPort,
    maxAttempts: 6,
    reservedPorts: new Set([reservedPort]),
  });
  assert.notEqual(selectedPort, occupiedPort, "The server should leave the occupied port alone");
  assert.notEqual(selectedPort, reservedPort, "The server should leave the companion port alone");
  assert(selectedPort > occupiedPort, "The server should choose a later fallback port");
} finally {
  await closeServer(appServer);
  await closeServer(blocker);
}

console.log("Port fallback verification passed.");
