import { getContainer } from "@cloudflare/containers";
import type { SenderContainer } from "./sender-container";

export interface EventEnv {
  DB: D1Database;
  EVENTS_ENABLED?: string;
  EVENT_ENCRYPTION_KEY?: string;
  SENDER_INTERNAL_SECRET?: string;
  SENDER?: Fetcher;
  SENDER_CONTAINER?: DurableObjectNamespace<SenderContainer>;
  SENDER_LOCAL_URL?: string;
  MCP_ALLOW_HTTP_LOCAL_TEST?: string;
  MCP_OWNER_SUB?: string;
}

type Sub = {
  id: string;
  owner_sub: string;
  board_id: string;
  callback_url: string;
  secret_iv: string;
  secret_ciphertext: string;
  expires_at: string;
  active: number;
};
type Delivery = Sub & {
  event_id: string;
  task_id: string;
  revision: number;
  event_created_at: string;
  attempts: number;
};

const encode = (value: string) => new TextEncoder().encode(value);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unbase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function eventReady(env: EventEnv, request: Request) {
  if (
    env.EVENTS_ENABLED !== "true" ||
    !env.DB ||
    !env.MCP_OWNER_SUB ||
    !env.EVENT_ENCRYPTION_KEY ||
    !env.SENDER_INTERNAL_SECRET ||
    env.SENDER_INTERNAL_SECRET.length < 32
  )
    return false;
  try {
    if (unbase64(env.EVENT_ENCRYPTION_KEY).length !== 32) return false;
    if (env.SENDER || env.SENDER_CONTAINER) return true;
    const url = env.SENDER_LOCAL_URL ? new URL(env.SENDER_LOCAL_URL) : null;
    return (
      env.MCP_ALLOW_HTTP_LOCAL_TEST === "true" &&
      ["localhost", "127.0.0.1"].includes(new URL(request.url).hostname) &&
      url?.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

const eventList = [
  {
    name: "task.ready",
    description:
      "個人ボードに新しい実行依頼が登録されました。タスク本文は get_task で取得してください。",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: { board_id: { type: "string", const: "personal" } },
      required: ["board_id"],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        task_id: { type: "string" },
        revision: { type: "integer" },
      },
      required: ["board_id", "task_id", "revision"],
      additionalProperties: false,
    },
  },
];

const rpc = (id: string | number, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const error = (id: string | number, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });
const key = async (env: EventEnv) =>
  crypto.subtle.importKey("raw", unbase64(env.EVENT_ENCRYPTION_KEY!), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
async function encrypt(env: EventEnv, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(env),
    encode(value),
  );
  return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}
async function decrypt(env: EventEnv, iv: string, ciphertext: string) {
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unbase64(iv) },
      await key(env),
      unbase64(ciphertext),
    ),
  );
}
async function subscriptionId(owner: string, url: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    encode(`${owner}\n${url}\ntask.ready\npersonal`),
  );
  return `sub_${hex(new Uint8Array(hash)).slice(0, 40)}`;
}
function validSecret(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("whsec_")) return false;
  try {
    const bytes = unbase64(value.slice(6));
    return bytes.length >= 24 && bytes.length <= 64;
  } catch {
    return false;
  }
}
function validCallback(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value))
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}
async function sign(secret: string, eventId: string, timestamp: string, body: string) {
  const signingKey = await crypto.subtle.importKey(
    "raw",
    unbase64(secret.slice(6)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `v1,${base64(new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, encode(`${eventId}.${timestamp}.${body}`))))}`;
}
async function send(
  env: EventEnv,
  url: string,
  secret: string,
  subscriptionId: string,
  id: string,
  body: string,
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": await sign(secret, id, timestamp, body),
    "x-mcp-subscription-id": subscriptionId,
  };
  const command = JSON.stringify({ url, headers, bodyBase64: base64(encode(body)) });
  const internalTimestamp = String(Math.floor(Date.now() / 1000));
  const internalKey = await crypto.subtle.importKey(
    "raw",
    encode(env.SENDER_INTERNAL_SECRET!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const internalSignature = hex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", internalKey, encode(`${internalTimestamp}.${command}`)),
    ),
  );
  const endpoint =
    env.SENDER || env.SENDER_CONTAINER ? "http://sender.internal/deliver" : env.SENDER_LOCAL_URL!;
  const container = env.SENDER_CONTAINER
    ? getContainer(env.SENDER_CONTAINER, "personal-sender")
    : null;
  if (container)
    await container.startAndWaitForPorts({
      startOptions: { envVars: { SENDER_INTERNAL_SECRET: env.SENDER_INTERNAL_SECRET! } },
    });
  const sender = container || env.SENDER;
  const response = sender
    ? await sender.fetch(endpoint, {
        method: "POST",
        headers: {
          "x-internal-timestamp": internalTimestamp,
          "x-internal-signature": internalSignature,
        },
        body: command,
      })
    : await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-internal-timestamp": internalTimestamp,
          "x-internal-signature": internalSignature,
        },
        body: command,
      });
  if (!response.ok) throw new Error("sender_failed");
  return (await response.json()) as { status: number; body: string };
}
function same(a: string, b: string) {
  const x = encode(a),
    y = encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function eventRpc(
  request: Request,
  env: EventEnv,
  owner: string,
  id: string | number,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<Response> {
  if (!eventReady(env, request)) return error(id, -32601, "イベント配信は無効です");
  if (method === "events/list") return rpc(id, { events: eventList });
  const args = params?.arguments as Record<string, unknown> | undefined;
  const delivery = params?.delivery as Record<string, unknown> | undefined;
  if (
    params?.name !== "task.ready" ||
    args?.board_id !== "personal" ||
    !delivery ||
    delivery.mode !== "webhook" ||
    !validCallback(delivery.url)
  )
    return error(id, -32602, "購読条件が不正です");
  const subId = await subscriptionId(owner, delivery.url);
  if (method === "events/unsubscribe") {
    await env.DB.prepare(
      "UPDATE event_subscriptions SET active=0,updated_at=? WHERE id=? AND owner_sub=?",
    )
      .bind(new Date().toISOString(), subId, owner)
      .run();
    return rpc(id, {});
  }
  if (method !== "events/subscribe" || !validSecret(delivery.secret))
    return error(id, -32602, "署名秘密が不正です");
  const challenge = crypto.randomUUID(),
    verificationId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    const result = await send(
      env,
      delivery.url,
      delivery.secret,
      subId,
      verificationId,
      JSON.stringify({ type: "verification", challenge }),
    );
    const echoed = JSON.parse(result.body) as { challenge?: string };
    if (
      result.status < 200 ||
      result.status >= 300 ||
      !echoed.challenge ||
      !same(challenge, echoed.challenge)
    )
      return error(id, -32015, "callback の検証に失敗しました");
  } catch {
    return error(id, -32015, "callback に接続できません");
  }
  const ttl =
    typeof params?.ttlMs === "number" && Number.isFinite(params.ttlMs) && params.ttlMs > 0
      ? Math.min(params.ttlMs, 24 * 60 * 60_000)
      : 24 * 60 * 60_000;
  const now = new Date().toISOString(),
    expires = new Date(Date.now() + ttl).toISOString();
  const encrypted = await encrypt(env, delivery.secret);
  await env.DB.prepare(
    "INSERT INTO event_subscriptions (id,owner_sub,board_id,callback_url,secret_iv,secret_ciphertext,expires_at,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET secret_iv=excluded.secret_iv,secret_ciphertext=excluded.secret_ciphertext,expires_at=excluded.expires_at,active=1,updated_at=excluded.updated_at",
  )
    .bind(
      subId,
      owner,
      "personal",
      delivery.url,
      encrypted.iv,
      encrypted.ciphertext,
      expires,
      now,
      now,
    )
    .run();
  return rpc(id, { id: subId, refreshBefore: expires, cursor: null, truncated: false });
}

export function readyStatement(env: EventEnv, taskId: string, revision: number, auditId: string) {
  return env.DB.prepare(
    "INSERT OR IGNORE INTO event_outbox (id,task_id,revision,created_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM task_events WHERE id=?)",
  ).bind(
    `evt_${crypto.randomUUID().replaceAll("-", "")}`,
    taskId,
    revision,
    new Date().toISOString(),
    auditId,
  );
}

export async function drainOutbox(env: EventEnv, request: Request) {
  if (!eventReady(env, request)) return { disabled: true };
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO event_deliveries (subscription_id,event_id,next_attempt_at) SELECT s.id,o.id,? FROM event_subscriptions s CROSS JOIN event_outbox o WHERE s.active=1 AND s.expires_at>? AND o.created_at>=s.created_at",
  )
    .bind(now, now)
    .run();
  const rows = await env.DB.prepare(
    "SELECT s.*,d.event_id,d.attempts,o.task_id,o.revision,o.created_at AS event_created_at FROM event_deliveries d JOIN event_subscriptions s ON s.id=d.subscription_id JOIN event_outbox o ON o.id=d.event_id WHERE d.state IN ('pending','sending') AND d.next_attempt_at<=? AND s.active=1 AND s.expires_at>? AND s.owner_sub=? ORDER BY d.next_attempt_at LIMIT 30",
  )
    .bind(now, now, env.MCP_OWNER_SUB || "")
    .all<Delivery>();
  let delivered = 0,
    retried = 0;
  for (const row of rows.results) {
    const reserved = await env.DB.prepare(
      "UPDATE event_deliveries SET state='sending',attempts=attempts+1,next_attempt_at=? WHERE subscription_id=? AND event_id=? AND state IN ('pending','sending') AND next_attempt_at<=?",
    )
      .bind(new Date(Date.now() + 30_000).toISOString(), row.id, row.event_id, now)
      .run();
    if (!reserved.meta.changes) continue;
    try {
      const secret = await decrypt(env, row.secret_iv, row.secret_ciphertext);
      const body = JSON.stringify({
        eventId: row.event_id,
        name: "task.ready",
        timestamp: row.event_created_at,
        data: { board_id: "personal", task_id: row.task_id, revision: row.revision },
        cursor: null,
      });
      const result = await send(env, row.callback_url, secret, row.id, row.event_id, body);
      if (result.status >= 200 && result.status < 300) {
        await env.DB.prepare(
          "UPDATE event_deliveries SET state='delivered',last_status=? WHERE subscription_id=? AND event_id=? AND state='sending'",
        )
          .bind(result.status, row.id, row.event_id)
          .run();
        delivered++;
      } else {
        const dead = result.status === 410 || result.status === 413 || row.attempts >= 4;
        await env.DB.prepare(
          "UPDATE event_deliveries SET state=?,last_status=?,next_attempt_at=? WHERE subscription_id=? AND event_id=?",
        )
          .bind(
            dead ? "dead" : "pending",
            result.status,
            new Date(Date.now() + Math.min(60, 2 ** row.attempts) * 60_000).toISOString(),
            row.id,
            row.event_id,
          )
          .run();
        retried++;
      }
    } catch {
      await env.DB.prepare(
        "UPDATE event_deliveries SET state=?,next_attempt_at=? WHERE subscription_id=? AND event_id=?",
      )
        .bind(
          row.attempts >= 4 ? "dead" : "pending",
          new Date(Date.now() + Math.min(60, 2 ** row.attempts) * 60_000).toISOString(),
          row.id,
          row.event_id,
        )
        .run();
      retried++;
    }
  }
  return { delivered, retried };
}
