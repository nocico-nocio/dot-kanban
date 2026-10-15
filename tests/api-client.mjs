import assert from "node:assert/strict";
import { requestJson } from "../src/api-client.ts";
import { t } from "../src/i18n.ts";
const original = globalThis.fetch;
try {
  let received;
  globalThis.fetch = async (_path, options) => {
    received = options;
    return Response.json({ ok: true });
  };
  await requestJson("/test", "ja", {
    method: "POST",
    headers: new Headers({ "if-match": "3", "content-type": "image/png" }),
    body: new Blob(["image"]),
  });
  assert.equal(received.headers.get("content-type"), "image/png");
  assert.equal(received.headers.get("if-match"), "3");
  globalThis.fetch = async () => Response.json({ code: "settings_conflict" }, { status: 409 });
  await assert.rejects(requestJson("/test", "ja"), { message: t("ja", "settings_conflict") });
  globalThis.fetch = async () => new Response("Login required", { status: 401 });
  await assert.rejects(requestJson("/test", "ja"), { message: t("ja", "auth_required") });
  globalThis.fetch = async () => new Response("bad gateway", { status: 502 });
  await assert.rejects(requestJson("/test", "ja"), { message: t("ja", "server_error") });
  globalThis.fetch = async () => Response.json({ code: "constructor" }, { status: 400 });
  await assert.rejects(requestJson("/test", "ja"), { message: t("ja", "server_error") });
} finally {
  globalThis.fetch = original;
}
console.log("PASS API header preservation and translated auth/non-JSON errors");
