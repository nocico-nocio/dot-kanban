import { execFileSync } from "node:child_process";
import { editableSettings } from "../worker/routing.ts";
import { startMockIdp } from "./mock-idp.mjs";
import { createHash } from "node:crypto";
import { accessConfigured, accessOwner } from "../worker/access.ts";
import { createSenderServer } from "../sender/server.mjs";
import { Webhook } from "standardwebhooks";
import { randomBytes } from "node:crypto";

const mock = await startMockIdp();
const eventSecret = "whsec_" + randomBytes(32).toString("base64");
const receivedEvents = [];
const mockSender = createSenderServer({
  secret: process.env.TEST_SENDER_INTERNAL_SECRET,
  deliverFn: async (command) => {
    new Webhook(eventSecret).verify(command.body.toString("utf8"), command.headers);
    const body = JSON.parse(command.body.toString("utf8"));
    receivedEvents.push(body);
    return {
      status: 200,
      body: body.type === "verification" ? JSON.stringify({ challenge: body.challenge }) : "{}",
    };
  },
});
await new Promise((resolve) => mockSender.listen(9193, "127.0.0.1", resolve));
const base = process.env.TEST_BASE_URL || "http://localhost:8787";
const admin = process.env.TEST_ADMIN_TOKEN;
const agent = process.env.TEST_AGENT_TOKEN;
if (!admin || !agent || !process.env.TEST_SENDER_INTERNAL_SECRET)
  throw new Error("TEST_* secrets are required");
const accessToken = await mock.token({ audience: "local-access-audience", type: "app" });
async function call(path, token, method = "GET", body, extra = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "cf-access-jwt-assertion": accessToken,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  try {
    return [response.status, JSON.parse(raw)];
  } catch {
    throw new Error(
      `Invalid JSON ${method} ${path} status=${response.status} body=${raw.slice(0, 400)}`,
    );
  }
}
const checks = [];
const ownerEnv = {
  ACCESS_TEAM_DOMAIN: "http://127.0.0.1:9191",
  ACCESS_AUD: "local-access-audience",
  ACCESS_OWNER_EMAIL: "owner@example.test",
  ACCESS_ALLOW_HTTP_LOCAL_TEST: "true",
};
const ownerRequest = () =>
  new Request(base, { headers: { "cf-access-jwt-assertion": accessToken } });
const certReads = mock.certificateRequests;
checks.push([
  "valid owner JWT accepted repeatedly",
  (await accessOwner(ownerRequest(), ownerEnv)) && (await accessOwner(ownerRequest(), ownerEnv)),
]);
checks.push(["Access certificate requests are cached", mock.certificateRequests - certReads === 1]);

checks.push([
  "Access missing config closed",
  !accessConfigured({}, new Request(base)) && !(await accessOwner(new Request(base), {})),
]);
checks.push(["board missing Access rejected", (await fetch(base)).status === 403]);
checks.push([
  "API missing Access rejected",
  (await fetch(base + "/api/tasks", { headers: { authorization: `Bearer ${admin}` } })).status ===
    403,
]);
checks.push([
  "board owner Access accepted",
  (await fetch(base, { headers: { "cf-access-jwt-assertion": accessToken } })).status === 200,
]);
for (const path of [
  "/settings",
  "/projects",
  "/connections",
  "/tasks/new",
  "/tasks/22222222-2222-4222-8222-222222222222",
]) {
  const response = await fetch(base + path, {
    headers: { "cf-access-jwt-assertion": accessToken },
  });
  checks.push([
    "SPA route serves app " + path,
    response.status === 200 && (await response.text()).includes('id="root"'),
  ]);
  checks.push(["SPA route protects Access " + path, (await fetch(base + path)).status === 403]);
}
const otherAccess = await mock.token({
  audience: "local-access-audience",
  type: "app",
  subject: "another-owner",
  email: "other@example.test",
});
checks.push([
  "other Access email rejected",
  (await fetch(base, { headers: { "cf-access-jwt-assertion": otherAccess } })).status === 403,
]);
const wrongAccessAud = await mock.token({ audience: "another-access-audience", type: "app" });
checks.push([
  "wrong Access audience rejected",
  (await fetch(base, { headers: { "cf-access-jwt-assertion": wrongAccessAud } })).status === 403,
]);
const serviceAccess = await mock.token({ audience: "local-access-audience", type: "service" });
checks.push([
  "service Access token rejected",
  (await fetch(base, { headers: { "cf-access-jwt-assertion": serviceAccess } })).status === 403,
]);
const expiredAccess = await mock.token({
  audience: "local-access-audience",
  type: "app",
  expires: "-10m",
});
checks.push([
  "expired Access rejected",
  (await fetch(base, { headers: { "cf-access-jwt-assertion": expiredAccess } })).status === 403,
]);
checks.push(["Access owner can read without admin token", (await call("/api/tasks"))[0] === 200]);
checks.push([
  "Access owner is admin without bearer token",
  (await call("/api/me"))[1].role === "admin",
]);
checks.push([
  "invalid bearer does not fall back to owner",
  (await call("/api/tasks", "invalid-token"))[0] === 401,
]);
checks.push([
  "cross-site owner write denied",
  (
    await call(
      "/api/tasks",
      undefined,
      "POST",
      { title: "CSRF attempt" },
      { origin: "https://untrusted.example" },
    )
  )[0] === 403,
]);
checks.push([
  "missing-origin owner write denied",
  (await call("/api/tasks", undefined, "POST", { title: "CSRF attempt" }))[0] === 403,
]);
checks.push([
  "same-origin owner write accepted",
  (
    await call(
      "/api/tasks",
      undefined,
      "POST",
      { title: "Access only", dispatch: "draft" },
      { origin: base },
    )
  )[0] === 201,
]);
const revisionRequest = (etag, token = admin, authenticated = true) =>
  fetch(base + "/api/board/revision", {
    headers: {
      ...(authenticated ? { "cf-access-jwt-assertion": accessToken } : {}),
      authorization: `Bearer ${token}`,
      ...(etag ? { "if-none-match": etag } : {}),
    },
  });
const boardRevision = async () => (await (await revisionRequest()).json()).revision;
const initialRevisionResponse = await revisionRequest();
const initialRevision = (await initialRevisionResponse.json()).revision;
const initialEtag = initialRevisionResponse.headers.get("etag");
checks.push([
  "board revision requires owner Access",
  (await revisionRequest(initialEtag, admin, false)).status === 403,
]);
checks.push([
  "agent cannot read global board revision",
  (await revisionRequest(initialEtag, agent)).status === 403,
]);
checks.push([
  "unchanged board returns empty 304",
  (await revisionRequest(initialEtag)).status === 304 &&
    (await (await revisionRequest(initialEtag)).text()) === "",
]);
checks.push([
  "board revision is private and not cached",
  initialRevisionResponse.headers.get("cache-control") === "private, no-store",
]);
const backlog = (await call("/api/tasks", admin, "POST", { title: "Backlog default" }))[1].task;
checks.push([
  "task creation changes board revision",
  (await boardRevision()) > initialRevision && (await revisionRequest(initialEtag)).status === 200,
]);
checks.push([
  "new task defaults to backlog",
  backlog.status === "backlog" && backlog.dispatch === "draft",
]);
checks.push(["new panel time is creation time", backlog.status_changed_at === backlog.created_at]);
checks.push([
  "backlog hidden from agent",
  (await call("/api/tasks", agent))[1].tasks.every((x) => x.id !== backlog.id),
]);
checks.push([
  "backlog cannot be claimed",
  (
    await call(
      "/api/tasks/" + backlog.id + "/claim",
      agent,
      "POST",
      {},
      { "if-match": String(backlog.version), "idempotency-key": "backlog-attempt-001" },
    )
  )[0] === 404,
]);
const promoted = await call(
  "/api/tasks/" + backlog.id,
  admin,
  "PATCH",
  { status: "todo" },
  { "if-match": String(backlog.version) },
);
checks.push([
  "backlog promotion requests work",
  promoted[0] === 200 &&
    promoted[1].task.status === "todo" &&
    promoted[1].task.dispatch === "requested",
]);
checks.push([
  "promotion records panel time",
  promoted[1].task.status_changed_at === promoted[1].task.updated_at &&
    promoted[1].task.status_changed_at > backlog.status_changed_at,
]);
checks.push([
  "promoted task visible to agent",
  (await call("/api/tasks", agent))[1].tasks.some((x) => x.id === backlog.id),
]);
checks.push([
  "backlog promotion version guard",
  (
    await call(
      "/api/tasks/" + backlog.id,
      admin,
      "PATCH",
      { status: "todo" },
      { "if-match": String(backlog.version) },
    )
  )[0] === 409,
]);
const demoted = await call(
  "/api/tasks/" + backlog.id,
  admin,
  "PATCH",
  { status: "backlog" },
  { "if-match": String(promoted[1].task.version) },
);
checks.push([
  "todo drag back to backlog",
  demoted[0] === 200 &&
    demoted[1].task.status === "backlog" &&
    demoted[1].task.dispatch === "draft",
]);
checks.push([
  "demotion records panel time",
  demoted[1].task.status_changed_at === demoted[1].task.updated_at &&
    demoted[1].task.status_changed_at > promoted[1].task.status_changed_at,
]);
checks.push([
  "demoted task hidden from agent",
  (await call("/api/tasks", agent))[1].tasks.every((x) => x.id !== backlog.id),
]);
const orderLow = (
  await call("/api/tasks", admin, "POST", {
    title: "Initially first",
    status: "todo",
    priority: "low",
  })
)[1].task;
const orderUrgent = (
  await call("/api/tasks", admin, "POST", {
    title: "Manual first",
    status: "todo",
    priority: "urgent",
  })
)[1].task;
const beforeOrder = (await call("/api/tasks", admin))[1];
checks.push([
  "initial order ignores legacy priority",
  beforeOrder.tasks.findIndex((x) => x.id === orderLow.id) <
    beforeOrder.tasks.findIndex((x) => x.id === orderUrgent.id),
]);
checks.push([
  "tasks no longer expose priority",
  beforeOrder.tasks.every((task) => !("priority" in task)),
]);
const revisionBeforeOrder = await boardRevision();
const reordered = await call(
  "/api/tasks/reorder",
  admin,
  "POST",
  { id: orderUrgent.id, status: "todo", before_id: orderLow.id, task_version: orderUrgent.version },
  { "if-match": String(beforeOrder.order_versions.todo) },
);
checks.push(["reorder changes board revision", (await boardRevision()) > revisionBeforeOrder]);
checks.push(["manual order saved", reordered[0] === 200 && reordered[1].ids[0] === orderUrgent.id]);
checks.push([
  "reorder preserves panel time",
  (await call("/api/tasks/" + orderUrgent.id, admin))[1].task.status_changed_at ===
    orderUrgent.status_changed_at,
]);
checks.push([
  "stale order rejected",
  (
    await call(
      "/api/tasks/reorder",
      admin,
      "POST",
      {
        id: orderLow.id,
        status: "todo",
        before_id: orderUrgent.id,
        task_version: orderLow.version,
      },
      { "if-match": String(beforeOrder.order_versions.todo) },
    )
  )[0] === 409,
]);
checks.push([
  "list follows manual order",
  (await call("/api/tasks", admin))[1].tasks.find((x) => x.status === "todo")?.id ===
    orderUrgent.id,
]);
checks.push([
  "next follows top card",
  (await call("/api/tasks/next", agent))[1].task?.id === orderUrgent.id,
]);
const archiveA = (await call("/api/tasks", admin, "POST", { title: "Archive A" }))[1].task;
const archiveB = (await call("/api/tasks", admin, "POST", { title: "Archive B" }))[1].task;
const archiveC = (await call("/api/tasks", admin, "POST", { title: "Archive C" }))[1].task;
const completed = [];
for (const item of [archiveA, archiveB, archiveC])
  completed.push(
    (
      await call(
        "/api/tasks/" + item.id,
        admin,
        "PATCH",
        { status: "done" },
        { "if-match": String(item.version) },
      )
    )[1].task,
  );
checks.push([
  "noncompleted cannot archive",
  (
    await call("/api/tasks/archive", admin, "POST", {
      tasks: [{ id: backlog.id, version: demoted[1].task.version }],
    })
  )[0] === 409,
]);
const revisionBeforeArchive = await boardRevision();
const archivedTwo = await call("/api/tasks/archive", admin, "POST", {
  tasks: completed.slice(0, 2).map((item) => ({ id: item.id, version: item.version })),
});
checks.push(["archive changes board revision", (await boardRevision()) > revisionBeforeArchive]);
checks.push([
  "selected completed archive",
  archivedTwo[0] === 200 && archivedTwo[1].archived === 2,
]);
checks.push([
  "archive hidden by default",
  !(await call("/api/tasks", admin))[1].tasks.some((item) => item.id === archiveA.id),
]);
checks.push([
  "archive visible on demand",
  (await call("/api/tasks?archived=1", admin))[1].tasks.some(
    (item) => item.id === archiveA.id && item.archived_at,
  ),
]);
checks.push([
  "agent list hides archive",
  !(await call("/api/tasks", agent))[1].tasks.some((item) => item.id === archiveA.id),
]);
checks.push([
  "agent detail hides archive",
  (await call("/api/tasks/" + archiveA.id, agent))[0] === 404,
]);
checks.push([
  "archived edit blocked",
  (
    await call(
      "/api/tasks/" + archiveA.id,
      admin,
      "PATCH",
      { status: "todo" },
      { "if-match": String(completed[0].version + 1) },
    )
  )[0] === 409,
]);
checks.push([
  "archived event blocked",
  (
    await call(
      "/api/tasks/" + archiveA.id + "/events",
      admin,
      "POST",
      { message: "Try", status: "todo" },
      { "if-match": String(completed[0].version + 1) },
    )
  )[0] === 409,
]);
checks.push([
  "stale selected archive rejected atomically",
  (
    await call("/api/tasks/archive", admin, "POST", {
      tasks: [
        { id: archiveA.id, version: completed[0].version },
        { id: archiveC.id, version: completed[2].version },
      ],
    })
  )[0] === 409 &&
    (await call("/api/tasks", admin))[1].tasks.some((item) => item.id === archiveC.id),
]);
const archivedAll = await call("/api/tasks/archive", admin, "POST", { all: true });
checks.push([
  "archive all completed",
  archivedAll[0] === 200 &&
    !(await call("/api/tasks", admin))[1].tasks.some((item) => item.id === archiveC.id),
]);
const archiveView = (await call("/api/tasks?archived=1", admin))[1];
const archivedA = archiveView.tasks.find((item) => item.id === archiveA.id);
checks.push(["archive count included", archiveView.archived_count >= 3]);
checks.push([
  "stale restore rejected",
  (
    await call("/api/tasks/unarchive", admin, "POST", {
      id: archiveA.id,
      version: completed[0].version,
    })
  )[0] === 409,
]);
const restored = await call("/api/tasks/unarchive", admin, "POST", {
  id: archiveA.id,
  version: archivedA.version,
});
checks.push([
  "archive restore",
  restored[0] === 200 &&
    !restored[1].task.archived_at &&
    (await call("/api/tasks", admin))[1].tasks.some((item) => item.id === archiveA.id),
]);
checks.push([
  "archive history",
  (await call("/api/tasks/" + archiveA.id, admin))[1].events.some(
    (item) => item.kind === "archived",
  ) &&
    (await call("/api/tasks/" + archiveA.id, admin))[1].events.some(
      (item) => item.kind === "unarchived",
    ),
]);
await call(
  "/api/tasks/" + orderLow.id,
  admin,
  "PATCH",
  { status: "review" },
  { "if-match": String(orderLow.version) },
);
await call(
  "/api/tasks/" + orderUrgent.id,
  admin,
  "PATCH",
  { status: "review" },
  { "if-match": String(orderUrgent.version) },
);
const preflight = await fetch(base + "/api/tasks", {
  method: "OPTIONS",
  headers: { origin: "https://untrusted.example", "access-control-request-method": "POST" },
});
checks.push([
  "cross origin denied",
  preflight.status === 403 && !preflight.headers.has("access-control-allow-origin"),
]);
checks.push(["mcp unauthorized", (await fetch(base + "/mcp", { method: "POST" })).status === 401]);
const metadataResponse = await fetch(base + "/.well-known/oauth-protected-resource/mcp");
const metadataRaw = await metadataResponse.text();
if (!metadataRaw) throw new Error(`Metadata empty status=${metadataResponse.status}`);
const metadata = JSON.parse(metadataRaw);
checks.push([
  "protected metadata",
  metadata.resource === base + "/mcp" && metadata.authorization_servers[0] === base,
]);
const created = await call("/api/tasks", admin, "POST", {
  title: "動作確認",
  description: "試験用",
  project: "demo",
  priority: "high",
  due_date: null,
  status: "todo",
  dispatch: "draft",
  approval_required: true,
});
const task = created[1].task;
checks.push(["created", created[0] === 201]);
checks.push(["legacy draft maps to backlog", task.status === "backlog"]);
checks.push([
  "draft hidden",
  (await call("/api/tasks", agent))[1].tasks.every((x) => x.id !== task.id),
]);
const changed = await call(
  "/api/tasks/" + task.id,
  admin,
  "PATCH",
  { dispatch: "requested" },
  { "if-match": String(task.version) },
);
checks.push(["request", changed[0] === 200 && changed[1].task.status === "todo"]);
checks.push([
  "stale version",
  (
    await call(
      "/api/tasks/" + task.id,
      admin,
      "PATCH",
      { title: "old" },
      { "if-match": String(task.version) },
    )
  )[0] === 409,
]);
const t = changed[1].task;
const claim = await call(
  "/api/tasks/" + task.id + "/claim",
  agent,
  "POST",
  {},
  { "if-match": String(t.version), "idempotency-key": "local-test-attempt-001" },
);
checks.push(["claim", claim[0] === 200]);
checks.push([
  "claim secret hidden in list",
  (await call("/api/tasks", agent))[1].tasks.every(
    (x) => !("claim_id" in x) && !("claim_key" in x),
  ),
]);
checks.push([
  "duplicate claim",
  (
    await call(
      "/api/tasks/" + task.id + "/claim",
      agent,
      "POST",
      {},
      { "if-match": String(t.version), "idempotency-key": "another-attempt-002" },
    )
  )[0] === 409,
]);
checks.push([
  "same-key retry",
  (
    await call(
      "/api/tasks/" + task.id + "/claim",
      agent,
      "POST",
      {},
      { "if-match": String(t.version), "idempotency-key": "local-test-attempt-001" },
    )
  )[1].claim_id === claim[1].claim_id,
]);
const c = claim[1].task;
checks.push([
  "claim records panel time",
  c.status_changed_at === c.updated_at && c.status_changed_at > t.status_changed_at,
]);
const renewed = await call(
  "/api/tasks/" + task.id + "/renew",
  agent,
  "POST",
  { claim_id: claim[1].claim_id },
  { "if-match": String(c.version) },
);
checks.push(["renew lease", renewed[0] === 200 && renewed[1].task.lease_expires_at]);
const active = renewed[1].task;
checks.push(["renew preserves panel time", active.status_changed_at === c.status_changed_at]);
checks.push([
  "approval blocks done",
  (
    await call(
      "/api/tasks/" + task.id + "/events",
      agent,
      "POST",
      { claim_id: claim[1].claim_id, message: "完了", status: "done" },
      { "if-match": String(active.version) },
    )
  )[0] === 409,
]);
checks.push([
  "unsafe result URL rejected",
  (
    await call(
      "/api/tasks/" + task.id + "/events",
      agent,
      "POST",
      { claim_id: claim[1].claim_id, message: "リンク", result_url: "javascript:alert(1)" },
      { "if-match": String(active.version) },
    )
  )[0] === 400,
]);
checks.push([
  "control character URL rejected",
  (
    await call(
      "/api/tasks/" + task.id + "/events",
      agent,
      "POST",
      { claim_id: claim[1].claim_id, message: "リンク", result_url: "https://example.com/\nfoo" },
      { "if-match": String(active.version) },
    )
  )[0] === 400,
]);
const review = await call(
  "/api/tasks/" + task.id + "/events",
  agent,
  "POST",
  {
    claim_id: claim[1].claim_id,
    message: "確認してください",
    status: "review",
    result_url: "https://example.com/result",
  },
  { "if-match": String(active.version) },
);
checks.push(["review", review[0] === 200]);
checks.push([
  "result transition records panel time",
  review[1].task.status_changed_at === review[1].task.updated_at &&
    review[1].task.status_changed_at > active.status_changed_at,
]);
checks.push([
  "history",
  (await call("/api/tasks/" + task.id, admin))[1].events.some(
    (x) => x.result_url === "https://example.com/result",
  ),
]);
checks.push([
  "audit transition",
  (await call("/api/tasks/" + task.id, admin))[1].events.some(
    (x) =>
      x.attempt_id === claim[1].claim_id &&
      x.previous_status === "in_progress" &&
      x.next_status === "review",
  ),
]);
const raceTask = (
  await call("/api/tasks", admin, "POST", {
    title: "競合試験",
    status: "todo",
    dispatch: "requested",
    approval_required: true,
  })
)[1].task;
const claims = await Promise.all([
  call(
    "/api/tasks/" + raceTask.id + "/claim",
    agent,
    "POST",
    {},
    { "if-match": String(raceTask.version), "idempotency-key": "race-attempt-0001" },
  ),
  call(
    "/api/tasks/" + raceTask.id + "/claim",
    agent,
    "POST",
    {},
    { "if-match": String(raceTask.version), "idempotency-key": "race-attempt-0002" },
  ),
]);
checks.push([
  "parallel claim single winner",
  claims.filter((x) => x[0] === 200).length === 1 &&
    claims.filter((x) => x[0] === 409).length === 1,
]);
const winner = claims.find((x) => x[0] === 200)[1];
const editedDuringRun = await call(
  "/api/tasks/" + raceTask.id,
  admin,
  "PATCH",
  { title: "競合試験を編集" },
  { "if-match": String(winner.task.version) },
);
checks.push([
  "title edit preserves panel time",
  editedDuringRun[1].task.status_changed_at === winner.task.status_changed_at,
]);
checks.push([
  "edit during claim retains review gate",
  editedDuringRun[0] === 200 &&
    editedDuringRun[1].task.approval_required === 1 &&
    editedDuringRun[1].task.status === "in_progress",
]);
checks.push([
  "agent stale revision rejected",
  (
    await call(
      "/api/tasks/" + raceTask.id + "/events",
      agent,
      "POST",
      { claim_id: winner.claim_id, message: "古い版", status: "review" },
      { "if-match": String(winner.task.version) },
    )
  )[0] === 409,
]);
const redirectUri = "http://127.0.0.1:9199/callback";
const registration = await fetch(base + "/oauth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Local MCP test",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
const registrationRaw = await registration.text();
if (!registrationRaw) throw new Error(`Registration empty status=${registration.status}`);
const registered = JSON.parse(registrationRaw);
checks.push([
  "client registration restricted",
  registration.status === 201 &&
    Boolean(registered.client_id) &&
    (
      await fetch(base + "/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://other.example/callback"],
          token_endpoint_auth_method: "none",
        }),
      })
    ).status === 400,
]);
for (const uri of [
  "https://www.cursor.com:444/agents/mcp/oauth/callback",
  "http://localhost:9198/other",
  "http://localhost:9198/callback?next=evil",
  "http://localhost.evil.example:9198/callback",
  "http://127.0.0.2:9198/callback",
]) {
  const rejected = await fetch(base + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: "none" }),
  });
  checks.push([`unlisted callback rejected: ${uri}`, rejected.status === 400]);
}
const verifier = randomBytes(40).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authorizeUrl = new URL(base + "/authorize");
for (const [key, value] of Object.entries({
  response_type: "code",
  client_id: registered.client_id,
  redirect_uri: redirectUri,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "local-state",
  scope: "tasks:read tasks:write offline_access",
  resource: base + "/mcp",
}))
  authorizeUrl.searchParams.set(key, value);
checks.push(["authorize Access required", (await fetch(authorizeUrl)).status === 403]);
checks.push([
  "authorize other owner denied",
  (await fetch(authorizeUrl, { headers: { "cf-access-jwt-assertion": otherAccess } })).status ===
    403,
]);
const authPage = await fetch(authorizeUrl, { headers: { "cf-access-jwt-assertion": accessToken } });
const authHtml = await authPage.text();
const handle = authHtml.match(/name="handle" value="([^"]+)"/)?.[1];
const setCookie = authPage.headers.get("set-cookie") || "";
const cookie = setCookie.split(";")[0];
checks.push([
  "consent binding cookie attributes",
  /^__Host-oauth-consent-[0-9a-f]{16}=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/.test(
    setCookie,
  ),
]);
checks.push([
  "consent posts to same URL",
  authHtml.includes('<form method="post">') && !authHtml.includes('<form method="post" action='),
]);
const consentForm = authHtml.match(/<form\b[^>]*>([\s\S]*?)<\/form>/)?.[1] || "";
const consentScopes = [
  ...consentForm.matchAll(/<input\b[^>]*name="scope"[^>]*value="([^"]+)"[^>]*checked[^>]*>/g),
].map((match) => match[1]);
checks.push([
  "authorize consent displayed",
  authPage.status === 200 &&
    authHtml.includes("Local MCP test") &&
    authHtml.includes("127.0.0.1") &&
    Boolean(handle) &&
    Boolean(cookie) &&
    consentScopes.join(" ") === "tasks:read tasks:write offline_access",
]);
const unboundApproval = await fetch(base + "/authorize", {
  method: "POST",
  headers: {
    "cf-access-jwt-assertion": accessToken,
    origin: base,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams([
    ["handle", handle],
    ["decision", "approve"],
    ...consentScopes.map((scope) => ["scope", scope]),
  ]),
});
checks.push([
  "consent requires browser binding cookie",
  unboundApproval.status === 400 &&
    (await unboundApproval.text()).includes("プラグイン詳細から接続をやり直してください"),
]);
const approval = await fetch(base + "/authorize", {
  method: "POST",
  redirect: "manual",
  headers: {
    "cf-access-jwt-assertion": accessToken,
    origin: base,
    cookie,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams([
    ["handle", handle],
    ["decision", "approve"],
    ...consentScopes.map((scope) => ["scope", scope]),
  ]),
});
const callback = new URL(approval.headers.get("location"));
const code = callback.searchParams.get("code");
checks.push([
  "authorization code issued",
  approval.status === 302 &&
    callback.origin === new URL(redirectUri).origin &&
    Boolean(code) &&
    callback.searchParams.get("state") === "local-state",
]);
async function token(form) {
  const response = await fetch(base + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  return [response.status, await response.json()];
}
const exchanged = await token({
  grant_type: "authorization_code",
  code,
  client_id: registered.client_id,
  redirect_uri: redirectUri,
  code_verifier: verifier,
  resource: base + "/mcp",
});
const bearer = exchanged[1].access_token;
checks.push([
  "code exchanged with audience and refresh",
  exchanged[0] === 200 &&
    Boolean(bearer) &&
    Boolean(exchanged[1].refresh_token) &&
    exchanged[1].expires_in <= 900,
]);
let rpcId = 0;
async function mcp(method, args, auth = bearer) {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method,
      params: method === "tools/call" ? args : args || {},
    }),
  });
  return [response.status, await response.json()];
}
checks.push([
  "Access assertion not MCP OAuth token",
  (
    await fetch(base + "/mcp", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": accessToken },
    })
  ).status === 401,
]);
checks.push(["MCP arbitrary bearer rejected", (await mcp("tools/list", {}, "invalid"))[0] === 401]);
const discovered = await mcp("server/discover", {});
checks.push([
  "mcp discovery",
  discovered[1].result.supportedVersions.includes("2026-07-28") &&
    !("events" in discovered[1].result.capabilities),
]);
checks.push(["mcp events unavailable", (await mcp("events/list", {}))[1].error.code === -32601]);
const catalog = await mcp("tools/list", {});
checks.push([
  "mcp task tools only",
  catalog[1].result.tools.some((x) => x.name === "list_tasks") &&
    catalog[1].result.tools.some((x) => x.name === "claim_task") &&
    !catalog[1].result.tools.some((x) => x.name === "get_routing_settings"),
]);
const listed = await mcp("tools/call", { name: "list_tasks", arguments: {} });
checks.push(["mcp list", listed[1].result.structuredContent.tasks.some((x) => x.id === task.id)]);
const fetched = await mcp("tools/call", { name: "get_task", arguments: { id: task.id } });
checks.push(["mcp get", fetched[1].result.structuredContent.task.id === task.id]);
const mcpCreated = await call("/api/tasks", admin, "POST", {
  title: "MCP テスト",
  description: "",
  project: "",
  priority: "medium",
  due_date: null,
  status: "todo",
  dispatch: "requested",
  approval_required: true,
});
const mt = mcpCreated[1].task;
const mcpClaim = await mcp("tools/call", {
  name: "claim_task",
  arguments: { id: mt.id, version: mt.version, idempotency_key: "mcp-attempt-0001" },
});
checks.push(["mcp claim", Boolean(mcpClaim[1].result.structuredContent.claim_id)]);
const mc = mcpClaim[1].result.structuredContent;
const mcpRenew = await mcp("tools/call", {
  name: "renew_claim",
  arguments: { id: mt.id, version: mc.task.version, claim_id: mc.claim_id },
});
checks.push(["mcp renew", Boolean(mcpRenew[1].result.structuredContent.task.lease_expires_at)]);
const mr = mcpRenew[1].result.structuredContent.task;
const mcpUpdate = await mcp("tools/call", {
  name: "append_task_update",
  arguments: { id: mt.id, version: mr.version, claim_id: mc.claim_id, message: "進行中" },
});
checks.push([
  "mcp progress",
  mcpUpdate[1].result.structuredContent.task.version === mr.version + 1,
]);
const mu = mcpUpdate[1].result.structuredContent.task;
const mcpStatus = await mcp("tools/call", {
  name: "set_task_status",
  arguments: {
    id: mt.id,
    version: mu.version,
    claim_id: mc.claim_id,
    status: "review",
    message: "確認してください",
    result_url: "https://example.com/mcp-result",
  },
});
checks.push([
  "mcp result and review",
  mcpStatus[1].result.structuredContent.task.status === "review",
]);
const grants = await fetch(base + "/api/connections", {
  headers: { "cf-access-jwt-assertion": accessToken },
});
const grantList = await grants.json();
checks.push(["owner connection list", grants.status === 200 && grantList.connections.length === 1]);
checks.push([
  "connection list other owner denied",
  (await fetch(base + "/api/connections", { headers: { "cf-access-jwt-assertion": otherAccess } }))
    .status === 403,
]);
const refreshed = await token({
  grant_type: "refresh_token",
  refresh_token: exchanged[1].refresh_token,
  client_id: registered.client_id,
  resource: base + "/mcp",
});
checks.push([
  "refresh rotates token",
  refreshed[0] === 200 &&
    refreshed[1].access_token !== bearer &&
    refreshed[1].refresh_token !== exchanged[1].refresh_token,
]);
checks.push([
  "refreshed access accepted",
  (await mcp("ping", {}, refreshed[1].access_token))[0] === 200,
]);
const initialSettings = await call("/api/settings", admin);
checks.push([
  "settings default compatible",
  initialSettings[0] === 200 &&
    initialSettings[1].config.targets.length === 0 &&
    initialSettings[1].version === 1,
]);
checks.push([
  "settings access requires owner",
  (await fetch(base + "/api/settings", { headers: { authorization: `Bearer ${admin}` } }))
    .status === 403,
]);
checks.push(["settings admin only", (await call("/api/settings", agent))[0] !== 200]);
const routingConfig = {
  targets: [
    { id: "device-one", label: "Device", kind: "device", enabled: true },
    { id: "cloud-one", label: "Cloud", kind: "cloud", enabled: true },
  ],
  agents: [
    {
      id: "codex",
      label: "Codex",
      enabled: true,
      adapter: "codex_cli",
      target_kinds: ["device", "cloud"],
    },
  ],
  models: [
    {
      id: "model-a",
      label: "A",
      agent_id: "codex",
      enabled: true,
      target_kinds: ["device", "cloud"],
    },
  ],
  rules: [
    {
      id: "coding",
      rank: 1,
      enabled: true,
      task_type: "coding",
      priority: "any",
      project: "",
      agent_id: "codex",
      model_id: "model-a",
      target_id: "device-one",
    },
  ],
};
const savedSettings = await call("/api/settings", admin, "PUT", routingConfig, { "if-match": "1" });
checks.push([
  "settings saved",
  savedSettings[0] === 200 &&
    savedSettings[1].version === 2 &&
    savedSettings[1].config.targets[0].connection_state === "unverified",
]);
checks.push([
  "settings stale rejected",
  (await call("/api/settings", admin, "PUT", routingConfig, { "if-match": "1" }))[0] === 409,
]);
const badRanks = {
  ...routingConfig,
  rules: [routingConfig.rules[0], { ...routingConfig.rules[0], id: "duplicate", rank: 1 }],
};
checks.push([
  "settings rank conflict rejected",
  (await call("/api/settings", admin, "PUT", badRanks, { "if-match": "2" }))[0] === 400,
]);
const services = [
  {
    id: "dot-kanban",
    name: "dot kanban",
    repository: "https://github.com/example/dot-kanban",
    icon: "https://example.com/favicon.svg",
  },
];
const savedServices = await call(
  "/api/settings",
  admin,
  "PUT",
  { ...routingConfig, services },
  { "if-match": "2" },
);
checks.push([
  "service metadata saved",
  savedServices[0] === 200 && savedServices[1].config.services[0].icon === services[0].icon,
]);
checks.push([
  "services persisted on reload",
  (await call("/api/settings", admin))[1].config.services[0].repository === services[0].repository,
]);
checks.push([
  "services available to board",
  (await call("/api/routing", admin))[1].config.services[0].name === "dot kanban",
]);
checks.push([
  "duplicate service rejected",
  (
    await call(
      "/api/settings",
      admin,
      "PUT",
      { ...routingConfig, services: [...services, { ...services[0], id: "other" }] },
      { "if-match": "3" },
    )
  )[0] === 400,
]);
checks.push([
  "unsafe icon rejected",
  (
    await call(
      "/api/settings",
      admin,
      "PUT",
      { ...routingConfig, services: [{ ...services[0], icon: "javascript:alert(1)" }] },
      { "if-match": "3" },
    )
  )[0] === 400,
]);
checks.push([
  "legacy settings writes preserve services",
  (await call("/api/settings", admin, "PUT", routingConfig, { "if-match": "3" }))[1].config
    .services[0].name === "dot kanban",
]);
checks.push([
  "service updated",
  (
    await call(
      "/api/settings",
      admin,
      "PUT",
      { ...routingConfig, services: [{ ...services[0], name: "Renamed" }] },
      { "if-match": "4" },
    )
  )[1].config.services[0].name === "Renamed",
]);
checks.push([
  "service removed",
  (
    await call(
      "/api/settings",
      admin,
      "PUT",
      { ...routingConfig, services: [] },
      { "if-match": "5" },
    )
  )[1].config.services.length === 0,
]);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK8sAAAAASUVORK5CYII=",
  "base64",
);
const uploadTaskImage = (bytes, bearer = admin, type = "image/png", origin = base) =>
  fetch(base + "/api/task-images", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": accessToken,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": type,
      origin,
    },
    body: bytes,
  });
checks.push([
  "task image upload requires owner",
  (await uploadTaskImage(png, agent)).status === 403,
]);
checks.push([
  "task image upload rejects cross-origin browser write",
  (await uploadTaskImage(png, null, "image/png", "https://evil.example")).status === 403,
]);
checks.push([
  "task image rejects SVG",
  (await uploadTaskImage(Buffer.from("<svg></svg>"), admin, "image/svg+xml")).status === 400,
]);
checks.push([
  "task image rejects invalid PNG",
  (await uploadTaskImage(Buffer.from("not an image"))).status === 400,
]);
checks.push([
  "task image rejects oversized body",
  (await uploadTaskImage(Buffer.alloc(1024 * 1024 + 1))).status === 400,
]);
const attachedUpload = await uploadTaskImage(png);
const attachedImage = await attachedUpload.json();
checks.push([
  "task image upload persists",
  attachedUpload.status === 201 && attachedImage.url.startsWith("/api/task-images/"),
]);
const readImage = await fetch(base + attachedImage.url, {
  headers: { "cf-access-jwt-assertion": accessToken },
});
checks.push([
  "task image read private and intact",
  readImage.status === 200 &&
    readImage.headers.get("cache-control").includes("no-store") &&
    Buffer.from(await readImage.arrayBuffer()).equals(png),
]);
checks.push(["task image is not public", (await fetch(base + attachedImage.url)).status === 403]);
const uploadIcon = (image, token = admin, type = "image/png", extra = {}) =>
  fetch(base + "/api/service-icons", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": accessToken,
      authorization: `Bearer ${token}`,
      "content-type": type,
      ...extra,
    },
    body: image,
  });
checks.push(["icon upload admin only", (await uploadIcon(png, agent)).status === 403]);
checks.push([
  "icon upload rejects SVG",
  (await uploadIcon("<svg></svg>", admin, "image/svg+xml")).status === 400,
]);
checks.push([
  "icon upload rejects oversized payload",
  (await uploadIcon(new Uint8Array(97 * 1024))).status === 400,
]);
const uploaded = await uploadIcon(png);
const uploadedIcon = await uploaded.json();
checks.push([
  "icon upload stored",
  uploaded.status === 201 && uploadedIcon.icon.startsWith("/api/service-icons/"),
]);
const imageResponse = await fetch(base + uploadedIcon.icon, {
  headers: { "cf-access-jwt-assertion": accessToken },
});
checks.push([
  "uploaded icon served to owner",
  imageResponse.status === 200 &&
    imageResponse.headers.get("content-type") === "image/png" &&
    Buffer.from(await imageResponse.arrayBuffer()).equals(png),
]);
checks.push([
  "uploaded icon requires Access",
  (await fetch(base + uploadedIcon.icon)).status === 403,
]);
const newProject = {
  id: "uploaded-project",
  name: "Uploaded project",
  repository: "",
  icon: uploadedIcon.icon,
};
const createdProject = await call("/api/services", admin, "POST", newProject);
checks.push([
  "project registered inline",
  createdProject[0] === 201 &&
    createdProject[1].service.icon === uploadedIcon.icon &&
    createdProject[1].config.targets.length === routingConfig.targets.length,
]);
checks.push([
  "duplicate inline project rejected",
  (await call("/api/services", admin, "POST", { ...newProject, id: "another-project" }))[0] === 400,
]);
checks.push([
  "project registration admin only",
  (
    await call("/api/services", agent, "POST", {
      ...newProject,
      id: "agent-project",
      name: "Agent project",
    })
  )[0] === 403,
]);
checks.push([
  "preset project registered",
  (
    await call("/api/services", admin, "POST", {
      id: "preset-project",
      name: "Preset project",
      repository: "",
      icon: "symbol:rocket",
    })
  )[0] === 201,
]);
checks.push([
  "unknown preset rejected",
  (
    await call("/api/services", admin, "POST", {
      id: "unknown-project",
      name: "Unknown project",
      repository: "",
      icon: "symbol:missing",
    })
  )[0] === 400,
]);
const routingPreview = await call("/api/routing/preview", admin, "POST", {
  task_type: "coding",
  priority: "high",
  project: "",
  agent_preference: "auto",
  model_preference: "auto",
  target_preference: "cloud-one",
});
checks.push([
  "manual target preview",
  routingPreview[0] === 200 &&
    routingPreview[1].routing.candidate_target_id === "cloud-one" &&
    routingPreview[1].routing.source === "manual",
]);
const manualTask = await call("/api/tasks", admin, "POST", {
  title: "Manual assignment",
  status: "todo",
  dispatch: "requested",
  task_type: "coding",
  agent_preference: "codex",
  model_preference: "model-a",
  target_preference: "device-one",
});
checks.push([
  "unconnected goes to review",
  manualTask[0] === 201 &&
    manualTask[1].task.status === "review" &&
    manualTask[1].task.routing.blocked_reasons.includes("target_unverified"),
]);
const manualDetail = await call("/api/tasks/" + manualTask[1].task.id, admin);
checks.push([
  "routing audit recorded",
  manualDetail[1].events.some(
    (x) => x.kind === "routing" && JSON.parse(x.body).target_id === "device-one",
  ),
]);
// These tasks now inherit the connected MCP agent. Exercise the same workflow through that identity.
async function assignedCall(path, _agent, method = "GET", body = {}, headers = {}) {
  const parts = path.split("/"),
    id = parts[3],
    action = parts[4];
  const name =
    id === "next"
      ? "next_eligible_task"
      : action === "claim"
        ? "claim_task"
        : action === "events"
          ? "set_task_status"
          : "get_task";
  const result = await mcp("tools/call", {
    name,
    arguments:
      name === "next_eligible_task"
        ? {}
        : {
            id,
            ...body,
            ...(headers["if-match"] ? { version: Number(headers["if-match"]) } : {}),
            ...(headers["idempotency-key"] ? { idempotency_key: headers["idempotency-key"] } : {}),
          },
  });
  return [
    result[1].result.isError ? result[1].result.structuredContent.status : 200,
    result[1].result.structuredContent,
  ];
}
const prerequisite = (
  await call("/api/tasks", admin, "POST", {
    title: "Prerequisite",
    priority: "urgent",
    dispatch: "requested",
    status: "todo",
  })
)[1].task;
const dependent = (
  await call("/api/tasks", admin, "POST", {
    title: "Dependent",
    priority: "urgent",
    dispatch: "requested",
    status: "todo",
    depends_on: [prerequisite.id],
  })
)[1].task;
const approvalTask = (
  await call("/api/tasks", admin, "POST", {
    title: "Needs approval",
    priority: "urgent",
    dispatch: "requested",
    status: "todo",
    approval_required: true,
  })
)[1].task;
const reviewTask = (
  await call("/api/tasks", admin, "POST", {
    title: "Review skip",
    priority: "urgent",
    dispatch: "requested",
    status: "todo",
  })
)[1].task;
await call(
  "/api/tasks/" + reviewTask.id,
  admin,
  "PATCH",
  { status: "review" },
  { "if-match": String(reviewTask.version) },
);
const stoppedTask = (
  await call("/api/tasks", admin, "POST", {
    title: "Stopped skip",
    priority: "urgent",
    dispatch: "requested",
    status: "todo",
  })
)[1].task;
await call(
  "/api/tasks/" + stoppedTask.id,
  admin,
  "PATCH",
  { status: "stopped" },
  { "if-match": String(stoppedTask.version) },
);
const firstNext = await assignedCall("/api/tasks/next", agent);
checks.push([
  "next chooses eligible",
  firstNext[0] === 200 && firstNext[1].task.id === prerequisite.id && !firstNext[1].waiting,
]);
checks.push([
  "next explains skips",
  firstNext[1].skipped.some(
    (x) => x.id === dependent.id && x.reasons.some((r) => r.startsWith("dependency_unresolved:")),
  ),
]);
checks.push([
  "dependency claim blocked",
  (
    await assignedCall(
      "/api/tasks/" + dependent.id + "/claim",
      agent,
      "POST",
      {},
      { "if-match": String(dependent.version), "idempotency-key": "dependent-attempt-001" },
    )
  )[0] === 409,
]);
const sequentialClaims = await Promise.all([
  assignedCall(
    "/api/tasks/" + prerequisite.id + "/claim",
    agent,
    "POST",
    {},
    { "if-match": String(prerequisite.version), "idempotency-key": "sequential-claim-001" },
  ),
  assignedCall(
    "/api/tasks/" + prerequisite.id + "/claim",
    agent,
    "POST",
    {},
    { "if-match": String(prerequisite.version), "idempotency-key": "sequential-claim-002" },
  ),
]);
checks.push([
  "next parallel claim single winner",
  sequentialClaims.filter((x) => x[0] === 200).length === 1 &&
    sequentialClaims.filter((x) => x[0] === 409).length === 1,
]);
const sequentialWinner = sequentialClaims.find((x) => x[0] === 200)[1];
const waiting = await assignedCall("/api/tasks/next", agent);
checks.push([
  "next waits with no eligible task",
  waiting[1].waiting === true &&
    waiting[1].task === null &&
    waiting[1].skipped.some(
      (x) => x.id === approvalTask.id && x.reasons.includes("approval_required"),
    ) &&
    waiting[1].skipped.some((x) => x.id === reviewTask.id && x.reasons.includes("status_review")) &&
    waiting[1].skipped.some((x) => x.id === stoppedTask.id && x.reasons.includes("status_stopped")),
]);
const finishedPrerequisite = await assignedCall(
  "/api/tasks/" + prerequisite.id + "/events",
  agent,
  "POST",
  { claim_id: sequentialWinner.claim_id, message: "Done", status: "done" },
  { "if-match": String(sequentialWinner.task.version) },
);
checks.push(["prerequisite done", finishedPrerequisite[0] === 200]);
const nextAfterDone = await assignedCall("/api/tasks/next", agent);
checks.push([
  "next after completion",
  nextAfterDone[1].task?.id === dependent.id &&
    nextAfterDone[1].task.depends_on.includes(prerequisite.id),
]);
const dependentClaim = await assignedCall(
  "/api/tasks/" + dependent.id + "/claim",
  agent,
  "POST",
  {},
  { "if-match": String(dependent.version), "idempotency-key": "dependent-attempt-001" },
);
checks.push(["dependency unlocked", dependentClaim[0] === 200]);
const nextTool = await mcp("tools/call", { name: "next_eligible_task", arguments: {} });
checks.push(["mcp next waits", nextTool[1].result.structuredContent.waiting === true]);
const revoked = await fetch(base + "/api/connections/" + grantList.connections[0].id, {
  method: "DELETE",
  headers: { "cf-access-jwt-assertion": accessToken, origin: base },
});
checks.push([
  "owner revokes connection",
  revoked.status === 200 &&
    (
      await token({
        grant_type: "refresh_token",
        refresh_token: refreshed[1].refresh_token,
        client_id: registered.client_id,
      })
    )[0] !== 200,
]);
checks.push([
  "revoked access rejected",
  (await mcp("ping", {}, refreshed[1].access_token))[0] === 401,
]);
const readAuthorize = new URL(authorizeUrl);
readAuthorize.searchParams.set("scope", "tasks:read");
readAuthorize.searchParams.set("state", "read-only");
const readPage = await fetch(readAuthorize, {
  headers: { "cf-access-jwt-assertion": accessToken },
});
const readHtml = await readPage.text();
const readHandle = readHtml.match(/name="handle" value="([^"]+)"/)?.[1];
const readApproval = await fetch(base + "/authorize", {
  method: "POST",
  redirect: "manual",
  headers: {
    "cf-access-jwt-assertion": accessToken,
    origin: base,
    cookie: readPage.headers.get("set-cookie")?.split(";")[0],
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams([
    ["handle", readHandle],
    ["decision", "approve"],
    ["scope", "tasks:read"],
  ]),
});
const readCode = new URL(readApproval.headers.get("location")).searchParams.get("code");
const readToken = await token({
  grant_type: "authorization_code",
  code: readCode,
  client_id: registered.client_id,
  redirect_uri: redirectUri,
  code_verifier: verifier,
  resource: base + "/mcp",
});
checks.push([
  "read-only token lists",
  readToken[0] === 200 &&
    (
      await mcp("tools/call", { name: "list_tasks", arguments: {} }, readToken[1].access_token)
    )[0] === 200,
]);
checks.push([
  "read-only token cannot claim",
  (
    await mcp(
      "tools/call",
      {
        name: "claim_task",
        arguments: { id: mt.id, version: mt.version, idempotency_key: "read-only-test-001" },
      },
      readToken[1].access_token,
    )
  )[0] === 403,
]);
// Two separately authorized installations must not claim or update one another's work.
async function connectAgent(name, callbackUri = redirectUri, registeredUri = callbackUri) {
  const registration = await fetch(base + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: Array.isArray(registeredUri) ? registeredUri : [registeredUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const client = await registration.json();
  if (Array.isArray(registeredUri)) {
    const unsupported = new URL(authorizeUrl);
    unsupported.searchParams.set("client_id", client.client_id);
    unsupported.searchParams.set("redirect_uri", "cursor://anysphere.cursor-mcp/oauth/callback");
    const refused = await fetch(unsupported, {
      redirect: "manual",
      headers: { "cf-access-jwt-assertion": accessToken },
    });
    checks.push([
      `${name} legacy scheme cannot receive an authorization code`,
      refused.status === 400 && !refused.headers.get("location"),
    ]);
  }
  const url = new URL(authorizeUrl);
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", callbackUri);
  const page = await fetch(url, { headers: { "cf-access-jwt-assertion": accessToken } }),
    html = await page.text();
  checks.push([
    `${name} consent only permits its callback origin`,
    page.headers
      .get("content-security-policy")
      ?.includes(`form-action 'self' ${new URL(callbackUri).origin};`),
  ]);
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  const approved = await fetch(base + "/authorize", {
    method: "POST",
    redirect: "manual",
    headers: {
      "cf-access-jwt-assertion": accessToken,
      origin: base,
      cookie: page.headers.get("set-cookie")?.split(";")[0],
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams([
      ["handle", handle],
      ["decision", "approve"],
      ...["tasks:read", "tasks:write", "offline_access"].map((scope) => ["scope", scope]),
    ]),
  });
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const result = await token({
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    redirect_uri: callbackUri,
    code_verifier: verifier,
    resource: base + "/mcp",
  });
  const state = (await call("/api/connections"))[1];
  return {
    bearer: result[1].access_token,
    id: state.connections.find((item) => item.client_id === client.client_id).id,
  };
}
const agentA = await connectAgent("ChatGPT"),
  agentB = await connectAgent("Claude", "http://localhost:9198/callback");
const stateA = (await call("/api/connections"))[1];
checks.push(["first writable connection is default", stateA.default_connection_id === agentA.id]);
const defaultTask = (
  await call("/api/tasks", admin, "POST", { title: "Default MCP assignment", status: "todo" })
)[1].task;
checks.push(["new task snapshots default connection", defaultTask.mcp_connection_id === agentA.id]);
const changeDefault = (id, version = stateA.version, origin = base) =>
  call(
    "/api/connections/default",
    undefined,
    "PUT",
    { connection_id: id },
    { origin, "if-match": String(version) },
  );
checks.push([
  "default change requires same origin",
  (await changeDefault(agentB.id, stateA.version, "https://other.example"))[0] === 403,
]);
checks.push(["unknown connection cannot be default", (await changeDefault("missing"))[0] === 400]);
const stateB = (await changeDefault(agentB.id))[1];
checks.push([
  "default change persists",
  (await call("/api/connections"))[1].default_connection_id === agentB.id,
]);
checks.push(["default version conflict rejected", (await changeDefault(agentA.id))[0] === 409]);
const otherTask = (
  await call("/api/tasks", admin, "POST", { title: "Second MCP assignment", status: "todo" })
)[1].task;
checks.push([
  "existing assignment survives default change",
  (await call("/api/tasks/" + defaultTask.id, admin))[1].task.mcp_connection_id === agentA.id &&
    otherTask.mcp_connection_id === agentB.id,
]);
checks.push([
  "invalid task connection rejected",
  (
    await call("/api/tasks", admin, "POST", {
      title: "Invalid assignment",
      mcp_connection_id: "missing",
    })
  )[0] === 400,
]);
const rpc = async (who, name, args = {}) =>
  (await mcp("tools/call", { name, arguments: args }, who.bearer))[1].result;
const aList = await rpc(agentA, "list_tasks"),
  bList = await rpc(agentB, "list_tasks");
checks.push([
  "MCP lists isolate assignments",
  aList.structuredContent.tasks.some((t) => t.id === defaultTask.id) &&
    !aList.structuredContent.tasks.some((t) => t.id === otherTask.id) &&
    bList.structuredContent.tasks.some((t) => t.id === otherTask.id) &&
    !bList.structuredContent.tasks.some((t) => t.id === defaultTask.id),
]);
checks.push([
  "next candidate belongs to caller",
  (await rpc(agentB, "next_eligible_task")).structuredContent.task.id === otherTask.id,
]);
checks.push([
  "other connection cannot fetch",
  (await rpc(agentB, "get_task", { id: defaultTask.id })).structuredContent.status === 403,
]);
checks.push([
  "other connection cannot claim",
  (
    await rpc(agentB, "claim_task", {
      id: defaultTask.id,
      version: defaultTask.version,
      idempotency_key: "wrong-connection-001",
    })
  ).structuredContent.status === 403,
]);
checks.push([
  "legacy REST cannot impersonate MCP",
  (
    await call(
      "/api/tasks/" + defaultTask.id + "/claim",
      agent,
      "POST",
      {},
      { "if-match": String(defaultTask.version), "idempotency-key": "legacy-impersonate-001" },
    )
  )[0] === 403,
]);
const owned = (
  await rpc(agentA, "claim_task", {
    id: defaultTask.id,
    version: defaultTask.version,
    idempotency_key: "right-connection-001",
  })
).structuredContent;
checks.push(["assigned connection can claim", Boolean(owned.claim_id)]);
checks.push([
  "claim retry cannot leak to another connection",
  (
    await rpc(agentB, "claim_task", {
      id: defaultTask.id,
      version: owned.task.version,
      idempotency_key: "right-connection-001",
    })
  ).structuredContent.status === 403,
]);
checks.push([
  "other connection cannot update with claim ID",
  (
    await rpc(agentB, "append_task_update", {
      id: defaultTask.id,
      version: owned.task.version,
      claim_id: owned.claim_id,
      message: "wrong caller",
    })
  ).structuredContent.status === 403,
]);
checks.push([
  "other connection cannot renew with claim ID",
  (
    await rpc(agentB, "renew_claim", {
      id: defaultTask.id,
      version: owned.task.version,
      claim_id: owned.claim_id,
    })
  ).structuredContent.status === 403,
]);
checks.push([
  "running assignment cannot change",
  (
    await call(
      "/api/tasks/" + defaultTask.id,
      admin,
      "PATCH",
      { mcp_connection_id: agentB.id },
      { "if-match": String(owned.task.version) },
    )
  )[0] === 409,
]);
const switched = (
  await call(
    "/api/tasks/" + otherTask.id,
    admin,
    "PATCH",
    { mcp_connection_id: agentA.id },
    { "if-match": String(otherTask.version) },
  )
)[1].task;
checks.push([
  "pending task assignment can change",
  switched.mcp_connection_id === agentA.id &&
    (await rpc(agentB, "next_eligible_task")).structuredContent.task === null,
]);
const createArgs = {
  title: "Direct conversation request",
  description: "Record before execution",
  project: "demo",
  status: "todo",
  idempotency_key: "direct-request-create-001",
};
const createReplies = await Promise.all([
  rpc(agentA, "create_task", createArgs),
  rpc(agentA, "create_task", createArgs),
]);
const direct = createReplies[0].structuredContent.task;
checks.push([
  "MCP create is available with write scope",
  (await mcp("tools/list", {}, agentA.bearer))[1].result.tools.some(
    (tool) => tool.name === "create_task" && tool.securitySchemes[0].scopes.includes("tasks:write"),
  ),
]);
checks.push([
  "MCP creation assigned to caller, not default",
  direct.title === createArgs.title &&
    direct.status === "todo" &&
    direct.mcp_connection_id === agentA.id,
]);
checks.push([
  "concurrent MCP creation is idempotent",
  createReplies[1].structuredContent.task.id === direct.id &&
    (await call("/api/tasks/" + direct.id, admin))[1].events.filter(
      (event) => event.kind === "created",
    ).length === 1,
]);
checks.push([
  "MCP create retry keeps original request",
  (await rpc(agentA, "create_task", { ...createArgs, title: "Retry changed title" }))
    .structuredContent.task.title === createArgs.title,
]);
checks.push([
  "MCP create cannot choose another agent",
  (
    await mcp(
      "tools/call",
      { name: "create_task", arguments: { ...createArgs, mcp_connection_id: agentB.id } },
      agentA.bearer,
    )
  )[1].error.code === -32602,
]);
checks.push([
  "MCP create rejects invalid status",
  (
    await mcp(
      "tools/call",
      { name: "create_task", arguments: { ...createArgs, status: "done" } },
      agentA.bearer,
    )
  )[1].error.code === -32602,
]);
checks.push([
  "read-only MCP cannot create",
  (
    await mcp(
      "tools/call",
      { name: "create_task", arguments: createArgs },
      readToken[1].access_token,
    )
  )[0] === 403,
]);
const draft = (
  await rpc(agentB, "create_task", {
    title: "Register for later",
    idempotency_key: createArgs.idempotency_key,
  })
).structuredContent.task;
checks.push([
  "MCP registration defaults to backlog with per-connection keys",
  draft.status === "backlog" && draft.id !== direct.id && draft.mcp_connection_id === agentB.id,
]);
checks.push([
  "MCP-created backlog stays out of execution",
  (
    await rpc(agentB, "claim_task", {
      id: draft.id,
      version: draft.version,
      idempotency_key: "draft-mcp-claim-001",
    })
  ).structuredContent.status === 404,
]);
const directClaim = (
  await rpc(agentA, "claim_task", {
    id: direct.id,
    version: direct.version,
    idempotency_key: "direct-request-claim-001",
  })
).structuredContent;
checks.push([
  "MCP-created request can be claimed",
  directClaim.task.status === "in_progress" && Boolean(directClaim.claim_id),
]);
const revisionBeforeMcpStatus = await boardRevision();
const directDone = (
  await rpc(agentA, "set_task_status", {
    id: direct.id,
    version: directClaim.task.version,
    claim_id: directClaim.claim_id,
    status: "done",
    message: "Completed direct request",
  })
).structuredContent;
checks.push([
  "MCP status update changes board revision",
  (await boardRevision()) > revisionBeforeMcpStatus,
]);
checks.push([
  "MCP direct request completes with history",
  directDone.task.status === "done" &&
    (await call("/api/tasks/" + direct.id, admin))[1].events.some(
      (event) => event.body === "Completed direct request",
    ),
]);
checks.push([
  "MCP initialization instructs recording direct requests",
  (await mcp("initialize", {}, agentA.bearer))[1].result.instructions.includes("create_task"),
]);
{
  // Resume an approved task directly from review, with a fresh lease and audit trail.
  const resumeTask = (
    await rpc(agentA, "create_task", {
      title: "Approval and resume",
      status: "todo",
      approval_required: true,
      idempotency_key: "resume-task-create-001",
    })
  ).structuredContent.task;
  const firstAttempt = (
    await rpc(agentA, "claim_task", {
      id: resumeTask.id,
      version: resumeTask.version,
      idempotency_key: "resume-first-claim-001",
    })
  ).structuredContent;
  const waiting = (
    await rpc(agentA, "set_task_status", {
      id: resumeTask.id,
      version: firstAttempt.task.version,
      claim_id: firstAttempt.claim_id,
      status: "review",
      message: "Waiting for explicit approval",
    })
  ).structuredContent.task;
  const resumeArgs = {
    id: waiting.id,
    version: waiting.version,
    status: "in_progress",
    idempotency_key: "resume-approved-attempt-001",
    message: "User approved the specified deletion only",
  };
  checks.push([
    "resume requires approval when flagged",
    (await rpc(agentA, "set_task_status", resumeArgs)).structuredContent.status === 409,
  ]);
  checks.push([
    "another connection cannot resume",
    (await rpc(agentB, "set_task_status", { ...resumeArgs, approval_confirmed: true }))
      .structuredContent.status === 403,
  ]);
  checks.push([
    "read-only MCP cannot resume",
    (
      await mcp(
        "tools/call",
        { name: "set_task_status", arguments: { ...resumeArgs, approval_confirmed: true } },
        readToken[1].access_token,
      )
    )[0] === 403,
  ]);
  checks.push([
    "resume rejects stale version",
    (
      await rpc(agentA, "set_task_status", {
        ...resumeArgs,
        approval_confirmed: true,
        version: waiting.version - 1,
      })
    ).structuredContent.status === 409,
  ]);
  checks.push([
    "resume needs a new idempotency key",
    (
      await rpc(agentA, "set_task_status", {
        ...resumeArgs,
        approval_confirmed: true,
        idempotency_key: "resume-first-claim-001",
      })
    ).structuredContent.status === 409,
  ]);
  const resumes = await Promise.all([
    rpc(agentA, "set_task_status", { ...resumeArgs, approval_confirmed: true }),
    rpc(agentA, "set_task_status", { ...resumeArgs, approval_confirmed: true }),
  ]);
  const resumed = resumes[0].structuredContent;
  checks.push([
    "review resumes directly with a fresh claim",
    resumed.task.status === "in_progress" &&
      Boolean(resumed.claim_id) &&
      resumed.claim_id !== firstAttempt.claim_id &&
      resumed.task.approval_required === 0,
  ]);
  checks.push([
    "concurrent resume is idempotent",
    resumes[1].structuredContent.claim_id === resumed.claim_id &&
      (await call("/api/tasks/" + waiting.id, admin))[1].events.filter(
        (event) => event.kind === "resumed",
      ).length === 1,
  ]);
  checks.push([
    "old claim cannot update resumed task",
    (
      await rpc(agentA, "append_task_update", {
        id: waiting.id,
        version: resumed.task.version,
        claim_id: firstAttempt.claim_id,
        message: "Old attempt",
      })
    ).structuredContent.status === 409,
  ]);
  checks.push([
    "running task cannot start a second resume",
    (
      await rpc(agentA, "set_task_status", {
        ...resumeArgs,
        version: resumed.task.version,
        idempotency_key: "resume-other-attempt-001",
      })
    ).structuredContent.status === 409,
  ]);
  const halted = (
    await rpc(agentA, "set_task_status", {
      id: waiting.id,
      version: resumed.task.version,
      claim_id: resumed.claim_id,
      status: "stopped",
      message: "Stopped for a user decision",
    })
  ).structuredContent.task;
  const restarted = (
    await rpc(agentA, "set_task_status", {
      ...resumeArgs,
      version: halted.version,
      idempotency_key: "resume-stopped-attempt-001",
      message: "User requested continuation after checking prior effects",
    })
  ).structuredContent;
  checks.push([
    "stopped task resumes with another fresh claim",
    restarted.task.status === "in_progress" && restarted.claim_id !== resumed.claim_id,
  ]);
  const finished = (
    await rpc(agentA, "set_task_status", {
      id: waiting.id,
      version: restarted.task.version,
      claim_id: restarted.claim_id,
      status: "done",
      message: "Completed approved scope",
    })
  ).structuredContent.task;
  checks.push(["resumed approved task can complete", finished.status === "done"]);
  checks.push([
    "completed task can resume",
    (
      await rpc(agentA, "set_task_status", {
        ...resumeArgs,
        version: finished.version,
        idempotency_key: "resume-completed-attempt-001",
      })
    ).structuredContent.task?.status === "in_progress",
  ]);
  const resumeHistory = (await call("/api/tasks/" + waiting.id, admin))[1].events;
  checks.push([
    "resume records approval and state transition",
    resumeHistory.some(
      (event) =>
        event.kind === "resumed" &&
        event.previous_status === "review" &&
        event.next_status === "in_progress" &&
        event.body.includes("User approved"),
    ),
  ]);
  const forRequeue = (
    await rpc(agentA, "set_task_status", {
      id: defaultTask.id,
      version: owned.task.version,
      claim_id: owned.claim_id,
      status: "review",
      message: "User decision needed",
    })
  ).structuredContent.task;
  const requeued = (
    await call(
      "/api/tasks/" + defaultTask.id,
      admin,
      "PATCH",
      { status: "todo" },
      { "if-match": String(forRequeue.version) },
    )
  )[1].task;
  checks.push([
    "UI can return review to todo",
    requeued.status === "todo" &&
      (await call("/api/tasks/" + defaultTask.id, admin))[1].events.some(
        (event) => event.kind === "requeued",
      ),
  ]);
  checks.push([
    "requeued task can be claimed",
    Boolean(
      (
        await rpc(agentA, "claim_task", {
          id: defaultTask.id,
          version: requeued.version,
          idempotency_key: "requeue-from-ui-claim-001",
        })
      ).structuredContent.claim_id,
    ),
  ]);
}
// Every public status can transition to every other status, including backlog and reopening done.
{
  const states = ["backlog", "todo", "in_progress", "review", "done", "stopped"];
  for (const from of states)
    for (const to of states) {
      let task = (
        await rpc(agentA, "create_task", {
          title: `State transition ${from} to ${to}`,
          status: "backlog",
          idempotency_key: `matrix-create-${from}-${to}`,
        })
      ).structuredContent.task;
      let lease;
      if (from !== "backlog") {
        const result = (
          await rpc(agentA, "set_task_status", {
            id: task.id,
            version: task.version,
            status: from,
            idempotency_key: `matrix-start-${from}-${to}`,
            message: "Prepare source state",
          })
        ).structuredContent;
        task = result.task;
        lease = result.claim_id;
      }
      checks.push([
        `get assigned ${from} task`,
        (await rpc(agentA, "get_task", { id: task.id })).structuredContent.task?.status === from,
      ]);
      const args = {
        id: task.id,
        version: task.version,
        claim_id: lease,
        status: to,
        idempotency_key: `matrix-target-${from}-${to}`,
        message: "User requested state change",
      };
      checks.push([
        `other connection cannot change ${from} to ${to}`,
        (await rpc(agentB, "set_task_status", args)).structuredContent.status === 403,
      ]);
      if (from === "in_progress" && to !== "in_progress")
        checks.push([
          `running to ${to} needs claim`,
          (await rpc(agentA, "set_task_status", { ...args, claim_id: undefined })).structuredContent
            .status === 409,
        ]);
      const result = (await rpc(agentA, "set_task_status", args)).structuredContent;
      checks.push([
        `${from} -> ${to}`,
        result.task?.status === to &&
          result.task?.version === task.version + 1 &&
          result.task?.dispatch === (to === "backlog" ? "draft" : "requested") &&
          (to === "in_progress"
            ? Boolean(result.claim_id)
            : result.task?.lease_expires_at === null),
      ]);
      const detail = (await rpc(agentA, "get_task", { id: task.id })).structuredContent;
      checks.push([
        `${from} -> ${to} audit`,
        detail.events.some(
          (event) =>
            event.previous_status === from &&
            event.next_status === to &&
            event.body === args.message,
        ),
      ]);
      checks.push([
        `${from} -> ${to} stale version rejected`,
        (
          await rpc(agentA, "set_task_status", {
            id: task.id,
            version: task.version,
            claim_id: result.claim_id,
            status: "review",
            message: "Stale update",
          })
        ).structuredContent.status === 409,
      ]);
      if (to === "backlog")
        checks.push([
          "backlog stays outside polling",
          !(await rpc(agentA, "list_tasks")).structuredContent.tasks.some(
            (item) => item.id === task.id,
          ),
        ]);
    }
  const approval = (
    await rpc(agentA, "create_task", {
      title: "Direct completion approval",
      approval_required: true,
      idempotency_key: "direct-approval-create",
    })
  ).structuredContent.task;
  const completion = {
    id: approval.id,
    version: approval.version,
    status: "done",
    message: "Owner approved completed work",
  };
  checks.push([
    "completion without lease still respects approval",
    (await rpc(agentA, "set_task_status", completion)).structuredContent.status === 409,
  ]);
  checks.push([
    "approved direct completion",
    (await rpc(agentA, "set_task_status", { ...completion, approval_confirmed: true }))
      .structuredContent.task?.approval_required === 0,
  ]);
}
const imageTask = (
  await call("/api/tasks", admin, "POST", {
    mcp_connection_id: agentA.id,
    title: "Task with screenshot",
    description: `Check this screenshot\n![screen](${attachedImage.url})`,
    status: "todo",
  })
)[1].task;
const imageArgs = { id: imageTask.id, image_id: attachedImage.url.split("/").pop() };
const mcpImage = await rpc(agentA, "get_task_image", imageArgs);
checks.push([
  "MCP returns assigned task image content",
  mcpImage.content[0].type === "image" &&
    mcpImage.content[0].mimeType === "image/png" &&
    Buffer.from(mcpImage.content[0].data, "base64").equals(png),
]);
checks.push([
  "MCP cannot read another connection image",
  (await rpc(agentB, "get_task_image", imageArgs)).structuredContent.status === 404,
]);
checks.push([
  "MCP cannot read unreferenced image",
  (await rpc(agentA, "get_task_image", { ...imageArgs, id: defaultTask.id })).structuredContent
    .status === 404,
]);
const stolenImageTask = (
  await rpc(agentB, "create_task", {
    title: "Copied image reference",
    description: `![screen](${attachedImage.url})`,
    status: "todo",
    idempotency_key: "copied-image-ref-001",
  })
).structuredContent.task;
checks.push([
  "MCP cannot gain image access by copying a URL",
  (await rpc(agentB, "get_task_image", { ...imageArgs, id: stolenImageTask.id })).structuredContent
    .status === 404,
]);
const secondImage = await (await uploadTaskImage(png)).json();
const updatedImageTask = (
  await call(
    "/api/tasks/" + imageTask.id,
    admin,
    "PATCH",
    { description: `![second](${secondImage.url})` },
    { "if-match": String(imageTask.version) },
  )
)[1].task;
checks.push([
  "owner edit binds a new attachment",
  (
    await rpc(agentA, "get_task_image", {
      id: updatedImageTask.id,
      image_id: secondImage.url.split("/").pop(),
    })
  ).content[0].type === "image",
]);
checks.push([
  "removed attachment no longer exposed through MCP",
  (await rpc(agentA, "get_task_image", imageArgs)).structuredContent.status === 404,
]);
const imageBacklog = (
  await rpc(agentA, "create_task", {
    title: "Image backlog",
    description: `![screen](${attachedImage.url})`,
    idempotency_key: "image-backlog-create-001",
  })
).structuredContent.task;
checks.push([
  "MCP cannot read backlog image",
  (await rpc(agentA, "get_task_image", { ...imageArgs, id: imageBacklog.id })).structuredContent
    .status === 404,
]);
await call("/api/connections/" + agentB.id, undefined, "DELETE", undefined, { origin: base });
checks.push([
  "revoked default falls back to first writable connection",
  (await call("/api/connections"))[1].default_connection_id === agentA.id,
]);

// Exercise server-side OAuth compatibility with each documented callback shape.
// These are protocol tests, not claims of a completed login in the real apps.
for (const [name, callback, registeredCallback] of [
  ["Claude variable port", "http://localhost:49151/callback", "http://localhost:9198/callback"],
  ["Codex", "http://127.0.0.1:49152/callback", "http://127.0.0.1/callback"],
  ["Gemini CLI", "http://localhost:49153/oauth/callback", "http://localhost/oauth/callback"],
  ["Cursor Desktop", "http://localhost:8787/callback", "http://localhost:8787/callback"],
  [
    "Cursor Web",
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "https://www.cursor.com/agents/mcp/oauth/callback",
  ],
  [
    "Grok Bot Desktop",
    "http://localhost:8787/callback",
    [
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "https://www.cursor.com/agents/mcp/oauth/callback",
      "http://localhost:8787/callback",
    ],
  ],
  [
    "Grok Bot Web",
    "https://www.cursor.com/agents/mcp/oauth/callback",
    [
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "https://www.cursor.com/agents/mcp/oauth/callback",
      "http://localhost:8787/callback",
    ],
  ],
]) {
  const connection = await connectAgent(name, callback, registeredCallback);
  const tools = await mcp("tools/list", {}, connection.bearer);
  checks.push([
    `${name} discovers tools`,
    tools[0] === 200 && tools[1].result.tools.some((tool) => tool.name === "create_task"),
  ]);
  const created = (
    await rpc(connection, "create_task", {
      title: `${name} protocol test`,
      description: "Isolated test database only",
      status: "todo",
      idempotency_key: `callback-test-${name.replaceAll(" ", "-")}`,
    })
  ).structuredContent;
  checks.push([
    `${name} writes its own task`,
    Boolean(created.task?.id) && created.task.mcp_connection_id === connection.id,
  ]);
  const tasks = (await rpc(connection, "list_tasks")).structuredContent.tasks;
  checks.push([`${name} reads its task`, tasks.some((task) => task.id === created.task?.id)]);
  await call("/api/connections/" + connection.id, undefined, "DELETE", undefined, { origin: base });
}

// Fault injection runs only against the isolated CI database.
if (process.env.TEST_D1_STORAGE) {
  const sql = (command) =>
    execFileSync(
      "./node_modules/.bin/wrangler",
      [
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        process.env.TEST_D1_STORAGE,
        "--command",
        command,
      ],
      { stdio: "ignore" },
    );
  const created = (
    await rpc(agentA, "create_task", {
      title: "Atomic audit test",
      status: "todo",
      idempotency_key: "review-audit-create-001",
    })
  ).structuredContent.task;
  const claim = (
    await rpc(agentA, "claim_task", {
      id: created.id,
      version: created.version,
      idempotency_key: "review-audit-claim-001",
    })
  ).structuredContent;
  sql(
    "CREATE TRIGGER review_fail_audit BEFORE INSERT ON task_events WHEN NEW.body='REVIEW_AUDIT_FAILURE' BEGIN SELECT RAISE(ABORT,'review fault'); END;",
  );
  try {
    const failed = await rpc(agentA, "append_task_update", {
      id: created.id,
      version: claim.task.version,
      claim_id: claim.claim_id,
      message: "REVIEW_AUDIT_FAILURE",
    });
    const detail = (await call("/api/tasks/" + created.id, admin))[1];
    checks.push([
      "progress and audit roll back together",
      failed.structuredContent.status === 500 &&
        detail.task.version === claim.task.version &&
        !detail.events.some((event) => event.body === "REVIEW_AUDIT_FAILURE"),
    ]);
  } finally {
    sql("DROP TRIGGER review_fail_audit;");
  }
  sql(
    `CREATE TRIGGER review_fail_audit BEFORE INSERT ON task_events WHEN NEW.task_id='${created.id}' AND NEW.kind='updated' BEGIN SELECT RAISE(ABORT,'review fault'); END;`,
  );
  try {
    const failed = await call(
      "/api/tasks/" + created.id,
      admin,
      "PATCH",
      { title: "Must roll back" },
      { "if-match": String(claim.task.version) },
    );
    const detail = (await call("/api/tasks/" + created.id, admin))[1];
    checks.push([
      "owner edit and audit roll back together",
      failed[0] === 500 &&
        detail.task.title === created.title &&
        detail.task.version === claim.task.version,
    ]);
  } finally {
    sql("DROP TRIGGER review_fail_audit;");
  }
  const pending = (
    await rpc(agentA, "create_task", {
      title: "Atomic outbox test",
      status: "backlog",
      idempotency_key: "review-outbox-create-001",
    })
  ).structuredContent.task;
  sql(
    "CREATE TRIGGER review_fail_outbox BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT,'review fault'); END;",
  );
  try {
    const failed = await rpc(agentA, "set_task_status", {
      id: pending.id,
      version: pending.version,
      status: "todo",
      message: "Outbox fault",
    });
    const detail = (await rpc(agentA, "get_task", { id: pending.id })).structuredContent;
    checks.push([
      "task, audit and outbox roll back together",
      failed.structuredContent.status === 500 &&
        detail.task.status === "backlog" &&
        detail.task.version === pending.version &&
        !detail.events.some((event) => event.body === "Outbox fault"),
    ]);
  } finally {
    sql("DROP TRIGGER review_fail_outbox;");
  }
  const settings = (await call("/api/settings", admin))[1];
  sql(
    "CREATE TRIGGER review_fail_settings BEFORE INSERT ON routing_settings_events BEGIN SELECT RAISE(ABORT,'review fault'); END;",
  );
  try {
    const failed = await call("/api/settings", admin, "PUT", editableSettings(settings.config), {
      "if-match": String(settings.version),
    });
    checks.push([
      "settings and audit roll back together",
      failed[0] === 500 && (await call("/api/settings", admin))[1].version === settings.version,
    ]);
  } finally {
    sql("DROP TRIGGER review_fail_settings;");
  }
}
checks.push([
  "legacy deadline rejects impossible calendar dates",
  (
    await call("/api/tasks", admin, "POST", {
      title: "Invalid legacy date",
      due_date: "2026-02-31",
    })
  )[0] === 400,
]);
checks.push([
  "legacy deadline accepts leap days",
  (
    await call("/api/tasks", admin, "POST", { title: "Valid leap date", due_date: "2024-02-29" })
  )[0] === 201,
]);
const archiveLimitTasks = [];
for (let offset = 0; offset < 100; offset += 10)
  archiveLimitTasks.push(
    ...(await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const task = (
          await call("/api/tasks", admin, "POST", { title: `Archive limit ${offset + index}` })
        )[1].task;
        return (
          await call(
            "/api/tasks/" + task.id,
            admin,
            "PATCH",
            { status: "done" },
            { "if-match": String(task.version) },
          )
        )[1].task;
      }),
    )),
  );
const archivedLimit = await call("/api/tasks/archive", admin, "POST", {
  tasks: archiveLimitTasks.map(({ id, version }) => ({ id, version })),
});
checks.push([
  "100-task archive stays within SQL parameter limits",
  archivedLimit[0] === 200 && archivedLimit[1].archived === 100,
]);
checks.push([
  "large archive has one history row per changed task",
  (await call("/api/tasks/" + archiveLimitTasks[99].id, admin))[1].events.filter(
    (event) => event.kind === "archived",
  ).length === 1,
]);
checks.push([
  "anonymous OAuth registration has a bounded body",
  (
    await fetch(base + "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(65_537),
    })
  ).status === 413,
]);

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some((x) => !x[1])) process.exitCode = 1;
await new Promise((resolve) => mock.server.close(resolve));
await new Promise((resolve) => mockSender.close(resolve));
