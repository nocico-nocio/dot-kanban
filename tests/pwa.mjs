import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const handlers = new Map();
const stored = new Map();
let fetches = 0;
let offline = false;
const context = {
  URL,
  Response,
  self: {
    location: { origin: "https://board.example.test" },
    addEventListener: (name, listener) => handlers.set(name, listener),
    clients: { claim: async () => {} },
    skipWaiting: () => {},
  },
  caches: {
    keys: async () => ["dot-kanban-static-v0", "dot-kanban-static-v1"],
    delete: async (name) => {
      stored.delete(name);
    },
    open: async (name) => ({
      match: async (request) => stored.get(name)?.get(request.url),
      put: async (request, response) => {
        if (!stored.has(name)) stored.set(name, new Map());
        stored.get(name).set(request.url, response);
      },
    }),
  },
  fetch: async (request) => {
    fetches++;
    if (offline) throw new Error("offline");
    const path = new URL(request.url).pathname;
    const response = new Response(
      path.endsWith(".js") ? "console.log(1)" : "<html>private</html>",
      { headers: { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html" } },
    );
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  },
};
vm.runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), context);
async function request(path, options = {}) {
  const target = {
    url: `https://board.example.test${path}`,
    method: "GET",
    mode: options.mode || "same-origin",
    headers: new Headers(options.headers),
  };
  let handled;
  handlers.get("fetch")({
    request: target,
    respondWith: (value) => {
      handled = value;
    },
  });
  return handled ? await handled : await context.fetch(target);
}
await request("/assets/index-CCuHQOso.js");
assert.equal(stored.get("dot-kanban-static-v1")?.size, 1);
await request("/assets/index-CCuHQOso.js");
assert.equal(fetches, 1, "hashed asset reused");
await request("/assets/index-CCuHQOso.js", { headers: { authorization: "Bearer secret" } });
assert.equal(fetches, 2, "authorized asset bypasses cache");
await request("/api/tasks");
await request("/login");
await request("/");
await request("/manifest.webmanifest");
assert.equal(stored.get("dot-kanban-static-v1")?.size, 1, "personal routes never cached");
offline = true;
const response = await request("/", { mode: "navigate" });
assert.equal(response.status, 503);
assert.match(await response.text(), /Connection required/);
assert.equal(stored.get("dot-kanban-static-v1")?.size, 1, "offline response not cached");
console.log("PASS PWA cache isolation and offline response");
