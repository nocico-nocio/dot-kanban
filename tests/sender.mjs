import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { createSenderServer, publicAddress, callbackUrl } from "../sender/server.mjs";

const checks = [];
for (const address of [
  "127.0.0.1",
  "10.0.0.1",
  "169.254.169.254",
  "100.64.0.1",
  "192.0.2.1",
  "::1",
  "fc00::1",
  "::ffff:127.0.0.1",
  "2001:db8::1",
])
  checks.push([`blocked ${address}`, !publicAddress(address)]);
checks.push(["public IP accepted", publicAddress("8.8.8.8")]);
for (const url of [
  "http://example.com",
  "https://localhost/",
  "https://127.0.0.1/",
  "https://user:pass@example.com/",
  "https://example.com:8443/",
]) {
  let blocked = false;
  try {
    callbackUrl(url);
  } catch {
    blocked = true;
  }
  checks.push([`callback blocked ${url}`, blocked]);
}
const seen = [];
const secret = randomBytes(32).toString("hex");
const server = createSenderServer({
  secret,
  deliverFn: async (command) => {
    seen.push(command);
    return {
      status: 200,
      body: JSON.stringify({ challenge: JSON.parse(command.body.toString()).challenge }),
    };
  },
});
await new Promise((resolve) => server.listen(9192, "127.0.0.1", resolve));
async function command(body, signed = true) {
  const raw = Buffer.from(
    JSON.stringify({
      url: "https://callback.example.com/mcp",
      headers: {
        "content-type": "application/json",
        "webhook-id": "msg_test_123",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": "v1,AAAA",
        "x-mcp-subscription-id": "sub_test_123",
      },
      bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64"),
    }),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(raw)
    .digest("hex");
  return fetch("http://127.0.0.1:9192/deliver", {
    method: "POST",
    headers: {
      "x-internal-timestamp": timestamp,
      "x-internal-signature": signed ? signature : "0".repeat(64),
    },
    body: raw,
  });
}
checks.push([
  "internal auth rejected",
  (await command({ type: "verification", challenge: "challenge-123456789" }, false)).status === 401,
]);
const verification = await command({ type: "verification", challenge: "challenge-123456789" });
checks.push([
  "verification path",
  verification.status === 200 && seen[0]?.url.hostname === "callback.example.com",
]);
const event = await command({
  eventId: "evt_123",
  name: "task.ready",
  timestamp: new Date().toISOString(),
  data: { board_id: "personal", task_id: "test", revision: 1 },
  cursor: null,
});
checks.push([
  "event path",
  event.status === 200 && seen[1]?.headers["webhook-id"] === "msg_test_123",
]);
await new Promise((resolve) => {
  const partial = http.request("http://127.0.0.1:9192/deliver", { method: "POST" });
  partial.on("error", () => {});
  partial.on("close", resolve);
  partial.write("partial body");
  setTimeout(() => partial.destroy(), 30);
});
await new Promise((resolve) => setTimeout(resolve, 30));
checks.push([
  "sender survives an aborted request body",
  (await fetch("http://127.0.0.1:9192/ping")).status === 200 && seen.length === 2,
]);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some((x) => !x[1])) process.exitCode = 1;
await new Promise((resolve) => server.close(resolve));
