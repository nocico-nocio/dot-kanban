import assert from "node:assert/strict";
import { createServer } from "node:http";
import { consentHeaders, consentRedirectPolicy } from "../worker/consent-policy.ts";
import { chromium } from "playwright";

const csp = consentRedirectPolicy("https://chatgpt.com/connector_platform_oauth_redirect");
assert.match(csp, /(?:^|;)\s*default-src 'none'(?:;|$)/);
assert.match(csp, /(?:^|;)\s*frame-ancestors 'none'(?:;|$)/);
assert.match(csp, /(?:^|;)\s*form-action 'self' https:\/\/chatgpt\.com(?:;|$)/);
assert.ok(!csp.includes("*"), "form-action has no wildcard");
for (const uri of [
  "http://localhost:38917/callback",
  "http://127.0.0.1:38917/callback",
  "http://[::1]:38917/callback",
  "https://claude.ai/api/mcp/auth_callback",
]) {
  assert.ok(consentRedirectPolicy(uri).includes(`form-action 'self' ${new URL(uri).origin};`));
}
for (const uri of [
  "http://evil.example/callback",
  "http://localhost.evil.example/callback",
  "https://user:password@example.test/callback",
  "javascript:alert(1)",
]) {
  assert.throws(() => consentRedirectPolicy(uri));
}
const oldCsp = consentHeaders["content-security-policy"];
const callbackPath = "/connector_platform_oauth_redirect";
let callbackHits = 0;
const callbackServer = createServer((request, response) => {
  if (request.url !== callbackPath) {
    response.writeHead(404).end();
    return;
  }
  callbackHits++;
  response.writeHead(200, { "content-type": "text/plain" }).end("callback reached");
});
await new Promise((resolve) => callbackServer.listen(0, "127.0.0.1", resolve));
const callbackOrigin = `http://127.0.0.1:${callbackServer.address().port}`;
const callbackUrl = callbackOrigin + callbackPath;
const posts = { old: 0, new: 0 };
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname.slice(1);
  if (!["old", "new"].includes(path)) {
    response.writeHead(404).end();
    return;
  }
  if (request.method === "GET") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": path === "old" ? oldCsp : consentRedirectPolicy(callbackUrl),
      "cache-control": "no-store",
    });
    response.end(
      '<!doctype html><html><form method="post"><button>許可する</button></form></html>',
    );
    return;
  }
  if (request.method === "POST") {
    posts[path]++;
    response.writeHead(302, { location: callbackUrl, "cache-control": "no-store" }).end();
    return;
  }
  response.writeHead(405).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  for (const [path, shouldComplete] of [
    ["old", false],
    ["new", true],
  ]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violation = new Promise((resolve) =>
      page.on("console", (message) => {
        if (message.type() === "error" && message.text().includes("form-action")) resolve();
      }),
    );
    await page.goto(`${base}/${path}`);
    await page.getByRole("button", { name: "許可する" }).click();
    if (shouldComplete) {
      await page.waitForURL(callbackUrl, { timeout: 5000 });
      assert.equal(await page.textContent("body"), "callback reached");
      assert.equal(callbackHits, 1);
    } else {
      await Promise.race([
        violation,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("CSP violation not observed")), 5000),
        ),
      ]);
      assert.equal(callbackHits, 0);
    }
    assert.equal(posts[path], 1, `${path} form POST reached server once`);
    await context.close();
  }
  console.log("CSP browser redirect regression passed");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => callbackServer.close(resolve));
}
