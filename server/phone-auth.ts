import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export interface PhoneAccessAuthConfig {
  issuer: string;
  audience: string;
  requiredScope: string;
  resource: string;
}

export class PhoneAccessAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneAccessAuthError";
  }
}

function normalizeIssuer(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

export function getAuth0JwksUrl(issuer: string) {
  return new URL(".well-known/jwks.json", normalizeIssuer(issuer));
}

export function getBearerToken(header: string | string[] | undefined) {
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function verifyPhoneAccessToken(
  token: string,
  config: PhoneAccessAuthConfig,
  getKey: JWTVerifyGetKey = createRemoteJWKSet(getAuth0JwksUrl(config.issuer)),
): Promise<AuthInfo> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, getKey, {
      issuer: normalizeIssuer(config.issuer),
      audience: config.audience,
      algorithms: ["RS256"],
    }));
  } catch (error) {
    throw new PhoneAccessAuthError(error instanceof Error ? error.message : "Invalid access token");
  }

  const scopeClaim = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
  const permissionClaim = Array.isArray(payload.permissions)
    ? (payload.permissions as unknown[]).filter((permission: unknown): permission is string => typeof permission === "string")
    : [];
  const scopes = Array.from(new Set([...scopeClaim, ...permissionClaim].filter(Boolean)));
  if (!scopes.includes(config.requiredScope)) {
    throw new PhoneAccessAuthError(`Access token is missing the ${config.requiredScope} scope`);
  }

  const clientId = typeof payload.azp === "string"
    ? payload.azp
    : typeof payload.client_id === "string"
      ? payload.client_id
      : typeof payload.sub === "string"
        ? payload.sub
        : "unknown";

  return {
    token,
    clientId,
    scopes,
    expiresAt: payload.exp,
    resource: new URL(config.resource),
    extra: { subject: payload.sub },
  };
}
