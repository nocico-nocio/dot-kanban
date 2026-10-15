export interface RedirectEnv {
  MCP_ALLOWED_REDIRECT_URI?: string;
  MCP_ALLOWED_REDIRECT_URIS?: string;
  MCP_ALLOW_LOOPBACK_PORT_VARIATION?: string;
}

export const allowedRedirects = (env: RedirectEnv): string[] => [
  ...new Set(
    [env.MCP_ALLOWED_REDIRECT_URI || "", ...(env.MCP_ALLOWED_REDIRECT_URIS || "").split(/[\n,]/)]
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];

function loopbackUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    // Only canonical, local HTTP URLs. No host aliases, credentials, fragments,
    // queries or path normalization; this option relaxes the port alone.
    return url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !value.includes("?") &&
      !value.includes("#") &&
      url.port !== "0" &&
      url.href === value
      ? url
      : null;
  } catch {
    return null;
  }
}

export function isAllowedRedirect(uri: string, env: RedirectEnv): boolean {
  const allowed = allowedRedirects(env);
  if (allowed.includes(uri)) return true;
  if (env.MCP_ALLOW_LOOPBACK_PORT_VARIATION !== "true") return false;
  const requested = loopbackUrl(uri);
  if (!requested) return false;
  return allowed.some((value) => {
    const registered = loopbackUrl(value);
    return (
      registered?.hostname === requested.hostname && registered.pathname === requested.pathname
    );
  });
}

const cursorLegacyCallback = "cursor://anysphere.cursor-mcp/oauth/callback";
const cursorCallbacks = [
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "http://localhost:8787/callback",
];

// Cursor / Grok Bot register this legacy alternative alongside the callbacks
// they actually use. Permit the known metadata only when an approved Cursor
// callback is also present. Never use this predicate for authorization itself.
export function isAllowedClientRegistration(uris: unknown, env: RedirectEnv): boolean {
  if (!Array.isArray(uris) || uris.length === 0) return false;
  const hasCursorCallback = uris.some(
    (uri) =>
      typeof uri === "string" && cursorCallbacks.includes(uri) && isAllowedRedirect(uri, env),
  );
  return uris.every(
    (uri) =>
      typeof uri === "string" &&
      (uri === cursorLegacyCallback ? hasCursorCallback : isAllowedRedirect(uri, env)),
  );
}
