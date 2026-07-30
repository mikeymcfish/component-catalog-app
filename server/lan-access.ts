import type { RequestHandler } from "express";
import { isIP } from "node:net";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface LanAccessConfig {
  bindHost: string;
  allowedHosts: ReadonlySet<string>;
}

export interface LanRequestDetails {
  method: string;
  hostHeader: string | undefined;
  originHeader: string | undefined;
  fetchSiteHeader: string | undefined;
  localPort: number | undefined;
}

export function isLanAccessEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.COMPONENT_CATALOG_LAN_ACCESS?.trim().toLowerCase() === "true";
}

export function isRfc1918Ipv4(value: string) {
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function loadLanAccessConfig(env: NodeJS.ProcessEnv = process.env): LanAccessConfig | null {
  if (!isLanAccessEnabled(env)) return null;

  const bindHost = env.HOST?.trim() || "";
  if (!isRfc1918Ipv4(bindHost)) {
    throw new Error(
      "COMPONENT_CATALOG_LAN_ACCESS requires HOST to be a specific private IPv4 address; wildcard, loopback, and public addresses are not allowed.",
    );
  }

  return { bindHost, allowedHosts: new Set([bindHost]) };
}

function parseHostAuthority(value: string | undefined) {
  if (!value) return null;
  const match = value.trim().match(/^([0-9]{1,3}(?:\.[0-9]{1,3}){3})(?::(\d{1,5}))?$/);
  if (!match || isIP(match[1]) !== 4) return null;

  const port = match[2] ? Number(match[2]) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { hostname: match[1], port };
}

function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/") {
      return null;
    }
    const port = parsed.port ? Number(parsed.port) : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { hostname: parsed.hostname, port };
  } catch {
    return null;
  }
}

export function evaluateLanRequest(
  config: LanAccessConfig,
  request: LanRequestDetails,
): "invalid-host" | "cross-origin" | "cross-site" | null {
  const authority = parseHostAuthority(request.hostHeader);
  if (
    !authority
    || !config.allowedHosts.has(authority.hostname)
    || authority.port !== request.localPort
  ) {
    return "invalid-host";
  }

  if (request.fetchSiteHeader?.toLowerCase() === "cross-site") return "cross-site";

  if (request.originHeader) {
    const origin = parseOrigin(request.originHeader);
    if (
      !origin
      || !config.allowedHosts.has(origin.hostname)
      || origin.port !== request.localPort
    ) {
      return "cross-origin";
    }
  }

  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  return null;
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function createLanAccessGuard(config: LanAccessConfig): RequestHandler {
  return (req, res, next) => {
    const rejection = evaluateLanRequest(config, {
      method: req.method,
      hostHeader: firstHeader(req.headers.host),
      originHeader: firstHeader(req.headers.origin),
      fetchSiteHeader: firstHeader(req.headers["sec-fetch-site"]),
      localPort: req.socket.localPort,
    });

    if (rejection) {
      res.status(403).json({ message: "Request rejected by local-network access policy" });
      return;
    }
    next();
  };
}

export function getRuntimeAccessMetadata(env: NodeJS.ProcessEnv = process.env) {
  return {
    bindHost: env.HOST?.trim() || "127.0.0.1",
    lanAccess: isLanAccessEnabled(env),
    productionMode: env.NODE_ENV === "production",
  };
}
