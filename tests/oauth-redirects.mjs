import assert from "node:assert/strict";
import {
  allowedRedirects,
  isAllowedRedirect,
  isAllowedClientRegistration,
} from "../worker/oauth-redirects.ts";

const env = {
  MCP_ALLOWED_REDIRECT_URI: "https://chatgpt.com/connector_platform_oauth_redirect",
  MCP_ALLOWED_REDIRECT_URIS:
    "http://localhost:38917/callback, http://127.0.0.1/callback\nhttp://[::1]/callback\nhttp://localhost/oauth/callback\nhttps://www.cursor.com/agents/mcp/oauth/callback",
};
assert.equal(allowedRedirects(env).length, 6);
assert.equal(isAllowedRedirect("http://localhost:38917/callback", env), true);
assert.equal(isAllowedRedirect("http://localhost:49152/callback", env), false);
assert.equal(
  isAllowedRedirect("http://localhost:49152/callback", {
    ...env,
    MCP_ALLOW_LOOPBACK_PORT_VARIATION: "false",
  }),
  false,
);
const native = { ...env, MCP_ALLOW_LOOPBACK_PORT_VARIATION: "true" };
for (const uri of [
  "http://localhost:49152/callback",
  "http://127.0.0.1:49153/callback",
  "http://[::1]:49154/callback",
  "http://localhost:49155/oauth/callback",
  "http://localhost:8787/callback",
  "http://127.0.0.1/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
])
  assert.equal(isAllowedRedirect(uri, native), true, uri);
for (const uri of [
  "http://localhost.evil.example:49152/callback",
  "http://evil.example/callback",
  "http://127.0.0.2:49152/callback",
  "http://127.1:49152/callback",
  "http://2130706433:49152/callback",
  "http://0.0.0.0:49152/callback",
  "https://localhost:49152/callback",
  "http://localhost:0/callback",
  "http://localhost:65536/callback",
  "http://localhost:49152/other",
  "http://localhost:49152/callback/extra",
  "http://localhost:49152/%63allback",
  "http://localhost:49152/../callback",
  "http://localhost:49152/callback?next=evil",
  "http://localhost:49152/callback#",
  "http://localhost:49152/callback?",
  "http://user@localhost:49152/callback",
  "http://localhost:49152/callback\n",
  "https://www.cursor.com:444/agents/mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback?next=evil",
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "not a URL",
])
  assert.equal(isAllowedRedirect(uri, native), false, uri);
assert.equal(
  isAllowedRedirect("http://localhost:49152/callback", {
    MCP_ALLOW_LOOPBACK_PORT_VARIATION: "true",
  }),
  false,
);
assert.equal(
  isAllowedRedirect("http://127.0.0.1:49152/callback", {
    MCP_ALLOWED_REDIRECT_URI: "http://localhost/callback",
    MCP_ALLOW_LOOPBACK_PORT_VARIATION: "true",
  }),
  false,
);
console.log("PASS exact callbacks and opt-in loopback port matching");

const legacy = "cursor://anysphere.cursor-mcp/oauth/callback";
const cursor = "https://www.cursor.com/agents/mcp/oauth/callback";
assert.equal(
  isAllowedClientRegistration([legacy, cursor, "http://localhost:8787/callback"], native),
  true,
);
assert.equal(isAllowedRedirect(legacy, native), false);
for (const uris of [
  [],
  null,
  [legacy],
  [legacy, "http://127.0.0.1/callback"],
  [legacy, "http://localhost:38917/callback"],
  [legacy, "https://evil.example/callback"],
  [legacy, cursor, "https://evil.example/callback"],
  ["other://anysphere.cursor-mcp/oauth/callback", cursor],
  [legacy + "?next=evil", cursor],
  [legacy, cursor, 123],
])
  assert.equal(isAllowedClientRegistration(uris, native), false, JSON.stringify(uris));
assert.equal(isAllowedClientRegistration([legacy, cursor], {}), false);
console.log("PASS Cursor legacy registration metadata cannot authorize a custom-scheme redirect");
