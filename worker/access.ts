import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_OWNER_EMAIL?: string;
  ACCESS_ALLOW_HTTP_LOCAL_TEST?: string;
}

export function accessConfigured(env: AccessEnv, request: Request) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ACCESS_OWNER_EMAIL) return false;
  try {
    const domain = new URL(env.ACCESS_TEAM_DOMAIN);
    const requested = new URL(request.url);
    const local =
      env.ACCESS_ALLOW_HTTP_LOCAL_TEST === "true" &&
      ["localhost", "127.0.0.1"].includes(requested.hostname) &&
      domain.protocol === "http:" &&
      domain.hostname === "127.0.0.1" &&
      domain.port === "9191";
    return (
      !domain.username &&
      !domain.password &&
      !domain.search &&
      !domain.hash &&
      domain.pathname === "/" &&
      (local ||
        (domain.protocol === "https:" &&
          domain.hostname.endsWith(".cloudflareaccess.com") &&
          !domain.port)) &&
      env.ACCESS_AUD.length >= 8 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ACCESS_OWNER_EMAIL)
    );
  } catch {
    return false;
  }
}

// Reuse the public-key cache (including jose's rotation handling) for this issuer.
let accessKeys: { url: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;
function verificationKeys(url: URL) {
  if (accessKeys?.url !== url.href) accessKeys = { url: url.href, keys: createRemoteJWKSet(url) };
  return accessKeys.keys;
}

export async function accessOwner(request: Request, env: AccessEnv): Promise<boolean> {
  if (!accessConfigured(env, request)) return false;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  try {
    const certs = new URL("/cdn-cgi/access/certs", env.ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(token, verificationKeys(certs), {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
      clockTolerance: 5,
    });
    return (
      payload.type === "app" &&
      typeof payload.sub === "string" &&
      payload.sub.length > 0 &&
      typeof payload.email === "string" &&
      payload.email.toLowerCase() === env.ACCESS_OWNER_EMAIL!.toLowerCase()
    );
  } catch {
    return false;
  }
}
