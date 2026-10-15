import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (existsSync(".dev.vars")) throw new Error("Refusing to overwrite an existing .dev.vars");
const temp = mkdtempSync(join(tmpdir(), "dot-kanban-ci-"));
const varsPath = ".dev.vars";
const token = () => randomBytes(32).toString("hex");
const admin = token(),
  agent = token(),
  sender = token();
const base = "http://localhost:8789";
const variables = {
  ADMIN_TOKEN: admin,
  AGENT_TOKEN: agent,
  ACCESS_TEAM_DOMAIN: "http://127.0.0.1:9191",
  ACCESS_AUD: "local-access-audience",
  ACCESS_OWNER_EMAIL: "owner@example.test",
  ACCESS_ALLOW_HTTP_LOCAL_TEST: "true",
  OAUTH_RESOURCE: base + "/mcp",
  MCP_ALLOWED_REDIRECT_URI: "http://127.0.0.1:9199/callback",
  MCP_ALLOWED_REDIRECT_URIS:
    "http://localhost:9198/callback,http://localhost/oauth/callback,https://www.cursor.com/agents/mcp/oauth/callback",
  MCP_ALLOW_LOOPBACK_PORT_VARIATION: "true",
  EVENTS_ENABLED: "true",
  SENDER_LOCAL_URL: "http://127.0.0.1:9193/deliver",
  SENDER_INTERNAL_SECRET: sender,
  EVENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};
let server;
let ownsVars = false;
function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
    child.on("error", reject);
  });
}
try {
  writeFileSync(
    varsPath,
    Object.entries(variables)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
  ownsVars = true;
  await run("./node_modules/.bin/wrangler", [
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    temp,
  ]);
  server = spawn(
    "./node_modules/.bin/wrangler",
    ["dev", "--local", "--port", "8789", "--persist-to", temp, "--log-level", "error"],
    { stdio: "inherit" },
  );
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("Wrangler exited before startup");
    try {
      const response = await fetch(base);
      if (response.status > 0) {
        ready = true;
        break;
      }
    } catch {
      /* server starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error("Wrangler did not start");
  await run(process.execPath, ["tests/api.mjs"], {
    TEST_BASE_URL: base,
    TEST_ADMIN_TOKEN: admin,
    TEST_AGENT_TOKEN: agent,
    TEST_SENDER_INTERNAL_SECRET: sender,
    TEST_D1_STORAGE: temp,
  });
  await run(process.execPath, ["tests/request-body.mjs"]);
  await run(process.execPath, ["tests/api-client.mjs"]);
  await run(process.execPath, ["tests/sender.mjs"]);
  await run(process.execPath, ["tests/routing.mjs"]);
  await run(process.execPath, ["tests/services.mjs"]);
  await run(process.execPath, ["tests/pwa.mjs"]);
  await run(process.execPath, ["tests/oauth-diagnostics.mjs"]);
  await run(process.execPath, ["tests/oauth-redirects.mjs"]);
} finally {
  if (server && server.exitCode === null) server.kill("SIGINT");
  if (ownsVars) rmSync(varsPath, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
