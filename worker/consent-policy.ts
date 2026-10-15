export const consentHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

// Call only after the redirect URI passes the configured allowlist and OAuth checks.
// Chromium also applies form-action to the redirect following the consent POST.
export function consentRedirectPolicy(redirectUri: string): string {
  const url = new URL(redirectUri);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("Invalid consent redirect origin");
  }
  return consentHeaders["content-security-policy"].replace(
    "form-action 'self'",
    `form-action 'self' ${url.origin}`,
  );
}
