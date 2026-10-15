import { messages, t, type Locale, type MessageKey } from "./i18n.ts";

export type ApiCall = <T>(path: string, options?: RequestInit) => Promise<T>;

export async function requestJson<T>(
  path: string,
  locale: Locale,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, { ...options, headers, cache: "no-store" });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(t(locale, navigator.onLine ? "server_error" : "offlineNeedsConnection"));
  }
  if (
    response.status === 401 ||
    (response.redirected && !response.headers.get("content-type")?.includes("application/json"))
  )
    throw new Error(t(locale, "auth_required"));
  let payload: T & { code?: string };
  try {
    payload = await response.json();
  } catch {
    throw new Error(t(locale, "server_error"));
  }
  if (!response.ok) {
    const code = payload?.code;
    throw new Error(
      t(
        locale,
        typeof code === "string" && Object.hasOwn(messages, code)
          ? (code as MessageKey)
          : "server_error",
      ),
    );
  }
  return payload;
}
