import assert from "node:assert/strict";
import { readRequestBytes, readRequestText } from "../worker/request-body.ts";
import { handleMcp } from "../worker/mcp.ts";

const request = (chunks, headers = {}, cancel = () => {}) =>
  new Request("https://board.test/mcp", {
    method: "POST",
    headers,
    duplex: "half",
    body: new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    }),
  });
let cancelled = false;
assert.equal(
  await readRequestBytes(
    request([new Uint8Array(6), new Uint8Array(6), new Uint8Array(999)], {}, () => {
      cancelled = true;
    }),
    10,
  ),
  null,
);
assert.equal(cancelled, true, "oversized chunked streams stop being consumed");
assert.equal(
  await readRequestBytes(request([new Uint8Array(12)], { "content-length": "1" }), 10),
  null,
  "actual bytes are checked independently of the header",
);
assert.equal(
  await readRequestText(request([new Uint8Array([0xff])]), 10),
  null,
  "invalid UTF-8 is rejected",
);
assert.equal(
  await readRequestText(request([new TextEncoder().encode("日本語")]), 8),
  null,
  "limits count bytes rather than characters",
);
let apiCalled = false;
const oversized = await handleMcp(
  request([new Uint8Array(65_537)], { "content-type": "application/json" }),
  new Set(["tasks:read"]),
  async () => {
    apiCalled = true;
    return Response.json({});
  },
);
assert.equal(oversized.status, 413);
assert.equal(apiCalled, false);
console.log("PASS bounded JSON/image streams, early cancellation and MCP request limits");
