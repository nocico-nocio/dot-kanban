/* Only hashed, same-origin build assets contain cacheable bytes. Never store HTML or responses from API/auth routes. */
const CACHE = "dot-kanban-static-v1";
const ASSET = /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|webp|woff2?)$/;
self.addEventListener("install", () => {});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("dot-kanban-static-") && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => {
        const language = (request.headers.get("accept-language") || "").toLowerCase();
        const message = language.startsWith("ja")
          ? "接続が必要です。オンラインになってから再度開いてください。"
          : language.startsWith("ko")
            ? "연결이 필요합니다. 온라인 상태에서 다시 여세요."
            : language.startsWith("zh")
              ? "需要網路連線。請連線後重新開啟。"
              : "Connection required. Reopen when online.";
        const safe =
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>dot kanban</title></head><body style="font:16px system-ui;padding:2rem;background:#f6f7f2;color:#143c31"><h1>dot kanban</h1><p>' +
          message +
          "</p></body></html>";
        return new Response(safe, {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }),
    );
    return;
  }
  if (!ASSET.test(url.pathname) || request.headers.has("authorization")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      const mime = response.headers.get("content-type") || "";
      if (
        response.ok &&
        response.type === "basic" &&
        !response.headers.has("set-cookie") &&
        /^(?:text\/css|(?:text|application)\/javascript|image\/(?:svg\+xml|png|webp)|font\/woff2?)/.test(
          mime,
        )
      )
        await cache.put(request, response.clone());
      return response;
    })(),
  );
});
