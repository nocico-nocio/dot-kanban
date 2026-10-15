import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { pathToFileURL } from "node:url";
import { createHmac, timingSafeEqual } from "node:crypto";
import ipaddr from "ipaddr.js";

const MAX_COMMAND = 350_000;
const MAX_BODY = 262_144;

export function publicAddress(value) {
  try {
    const address = ipaddr.parse(value);
    return (
      address.range() === "unicast" && !(address.kind() === "ipv6" && address.isIPv4MappedAddress())
    );
  } catch {
    return false;
  }
}

export function callbackUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("invalid_callback");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".internal") ||
    ipaddr.isValid(url.hostname)
  )
    throw new Error("invalid_callback");
  return url;
}

function exactHeaders(value) {
  const names = [
    "content-type",
    "webhook-id",
    "webhook-timestamp",
    "webhook-signature",
    "x-mcp-subscription-id",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    Object.keys(value).some((key) => !names.includes(key))
  )
    throw new Error("invalid_headers");
  if (
    value["content-type"] !== "application/json" ||
    !/^v1,[A-Za-z0-9+/=]+$/.test(value["webhook-signature"]) ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(value["webhook-id"]) ||
    !/^\d{10}$/.test(value["webhook-timestamp"]) ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(value["x-mcp-subscription-id"])
  )
    throw new Error("invalid_headers");
  return value;
}

export function parseCommand(raw) {
  if (raw.length > MAX_COMMAND) throw new Error("command_too_large");
  const value = JSON.parse(raw.toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "bodyBase64,headers,url"
  )
    throw new Error("invalid_command");
  const url = callbackUrl(value.url);
  const headers = exactHeaders(value.headers);
  if (typeof value.bodyBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.bodyBase64))
    throw new Error("invalid_body");
  const body = Buffer.from(value.bodyBase64, "base64");
  if (!body.length || body.length > MAX_BODY || body.toString("base64") !== value.bodyBase64)
    throw new Error("invalid_body");
  const parsed = JSON.parse(body.toString("utf8"));
  if (
    parsed.type !== "verification" &&
    !(
      parsed.name === "task.ready" &&
      parsed.data?.board_id === "personal" &&
      typeof parsed.data?.task_id === "string"
    )
  )
    throw new Error("invalid_body");
  if (
    parsed.type === "verification" &&
    (typeof parsed.challenge !== "string" ||
      parsed.challenge.length < 16 ||
      parsed.challenge.length > 128)
  )
    throw new Error("invalid_body");
  return { url, headers, body };
}

export function verifyInternal(raw, timestamp, signature, secret) {
  if (
    !secret ||
    secret.length < 32 ||
    !/^\d{10}$/.test(timestamp || "") ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 ||
    !/^[a-f0-9]{64}$/.test(signature || "")
  )
    return false;
  const expected = createHmac("sha256", secret).update(timestamp).update(".").update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function deliver(command) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      command.url,
      {
        method: "POST",
        agent: false,
        timeout: 10_000,
        headers: { ...command.headers, "content-length": command.body.length, connection: "close" },
        lookup(hostname, options, callback) {
          dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (
              error ||
              !addresses?.length ||
              addresses.some((item) => !publicAddress(item.address))
            )
              return callback(error || new Error("non_public_address"));
            const chosen = addresses[0];
            if (options.all) callback(null, [chosen]);
            else callback(null, chosen.address, chosen.family);
          });
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16_384) request.destroy(new Error("response_too_large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("response_aborted")));
        response.on("end", () => {
          if (response.statusCode >= 300 && response.statusCode < 400)
            return reject(new Error("redirect_rejected"));
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    // Bound total delivery time as well as socket inactivity (including DNS lookup).
    const deadline = setTimeout(() => request.destroy(new Error("timeout")), 10_000);
    request.once("close", () => clearTimeout(deadline));
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end(command.body);
  });
}

export function createSenderServer({ secret, deliverFn = deliver } = {}) {
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/ping") {
      response.writeHead(secret?.length >= 32 ? 200 : 503);
      response.end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/deliver" || !secret || secret.length < 32) {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_COMMAND) {
          response.writeHead(413);
          response.end();
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      if (!response.destroyed) {
        response.writeHead(400);
        response.end();
      }
      return;
    }
    const raw = Buffer.concat(chunks);
    if (
      !verifyInternal(
        raw,
        request.headers["x-internal-timestamp"],
        request.headers["x-internal-signature"],
        secret,
      )
    ) {
      response.writeHead(401);
      response.end();
      return;
    }
    try {
      const command = parseCommand(raw);
      const result = await deliverFn(command);
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: result.status, body: result.body.slice(0, 16_384) }));
    } catch {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "delivery_failed" }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createSenderServer({ secret: process.env.SENDER_INTERNAL_SECRET });
  server.listen(Number(process.env.PORT || 8080), process.env.SENDER_BIND || "127.0.0.1");
}
