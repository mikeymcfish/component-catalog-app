import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const MAX_TCP_PORT = 65_535;

export function formatHttpUrl(host: string, port: number) {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export function parseTcpPort(value: string | undefined, fallback: number, label: string) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TCP_PORT) {
    throw new Error(`${label} must be an integer from 1 to ${MAX_TCP_PORT}.`);
  }
  return parsed;
}

export function buildPortCandidates(
  preferredPort: number,
  maxAttempts = 20,
  reservedPorts: ReadonlySet<number> = new Set(),
) {
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > MAX_TCP_PORT) {
    throw new Error(`Preferred port must be an integer from 1 to ${MAX_TCP_PORT}.`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Port fallback attempts must be a positive integer.");
  }

  const candidates: number[] = [];
  for (let port = preferredPort; port <= MAX_TCP_PORT && candidates.length < maxAttempts; port += 1) {
    // An explicitly requested preferred port wins, but automatic fallback
    // avoids ports reserved for companion services such as the phone MCP.
    if (port !== preferredPort && reservedPorts.has(port)) continue;
    candidates.push(port);
  }
  return candidates;
}

function listenOnce(server: Server, host: string, port: number, reusePort: boolean) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen({ host, port, ...(reusePort ? { reusePort: true } : {}) });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export async function listenWithPortFallback(
  server: Server,
  options: {
    host: string;
    preferredPort: number;
    maxAttempts?: number;
    reservedPorts?: ReadonlySet<number>;
    reusePort?: boolean;
    onPortUnavailable?: (unavailablePort: number, nextPort: number | null) => void;
  },
) {
  const candidates = buildPortCandidates(
    options.preferredPort,
    options.maxAttempts,
    options.reservedPorts,
  );
  let lastError: NodeJS.ErrnoException | null = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const port = candidates[index];
    try {
      await listenOnce(server, options.host, port, options.reusePort ?? false);
      const address = server.address() as AddressInfo | null;
      if (!address) throw new Error("Server started without a TCP address.");
      return address.port;
    } catch (error) {
      const networkError = error as NodeJS.ErrnoException;
      if (networkError.code !== "EADDRINUSE") throw error;
      lastError = networkError;
      options.onPortUnavailable?.(port, candidates[index + 1] ?? null);
    }
  }

  const attempted = candidates.join(", ");
  const failure = new Error(`No available local port was found. Tried: ${attempted}.`);
  if (lastError) failure.cause = lastError;
  throw failure;
}
