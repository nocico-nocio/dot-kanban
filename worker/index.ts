import { readRequestBytes, readRequestText } from "./request-body.ts";
import { handleMcp } from "./mcp";
import {
  connectionState,
  canExecute,
  validConnectionId,
  type ConnectionState,
} from "./connections";
import { rejectedRedirectSummary } from "./oauth-diagnostics";
import { renderConsentPage, renderConsentError } from "./consent-page";
import { consentHeaders, consentRedirectPolicy } from "./consent-policy";
import {
  allowedRedirects,
  isAllowedRedirect,
  isAllowedClientRegistration,
  type RedirectEnv,
} from "./oauth-redirects";
import { readProjectIcon } from "./project-icons";
import { readTaskImage } from "./task-images";
import { taskImages } from "../shared/task-images";
import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  insufficientScope,
  type OAuthHelpers,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { drainOutbox, readyStatement, type EventEnv } from "./events";
import { accessConfigured, accessOwner, type AccessEnv } from "./access";
import {
  preferencesSchema,
  publicSettings,
  resolveRouting,
  serviceSchema,
  settingsSchema,
  type RoutingSettings,
} from "./routing";
export { SenderContainer } from "./sender-container";

interface Env extends EventEnv, AccessEnv, RedirectEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
  AGENT_TOKEN?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_RESOURCE?: string;
  OAUTH_PROVIDER?: OAuthHelpers;
}

type Role = "admin" | "agent";
type Task = {
  status_changed_at: string | null;
  id: string;
  title: string;
  description: string;
  project: string;
  priority: "low" | "medium" | "high" | "urgent";
  due_date: string | null;
  status: "todo" | "in_progress" | "review" | "done" | "stopped";
  dispatch: "draft" | "requested";
  approval_required: number;
  depends_on: string;
  task_type: "general" | "coding" | "research" | "writing";
  agent_preference: string;
  model_preference: string;
  target_preference: string;
  mcp_connection_id: string | null;
  claim_id: string | null;
  claim_key: string | null;
  lease_expires_at: string | null;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
const failure = (
  message: string,
  status: number,
  code = status === 400
    ? "request_invalid"
    : status === 401
      ? "auth_required"
      : status === 403
        ? "forbidden"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 503
              ? "config_required"
              : "server_error",
) => json({ error: message, code }, status);
const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const optionalText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const oneOf = <T extends string>(value: unknown, list: readonly T[]): value is T =>
  typeof value === "string" && list.includes(value as T);
const priorities = ["low", "medium", "high", "urgent"] as const;
const statuses = ["backlog", "todo", "in_progress", "review", "done", "stopped"] as const;
const dispatches = ["draft", "requested"] as const;
function validResultUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value))
    return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(x),
    right = new Uint8Array(y);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function roleFor(request: Request, env: Env): Promise<Role | null> {
  const header = request.headers.get("authorization");
  if (!header) return "admin";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  if (!token) return null;
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 24 && (await sameSecret(token, env.ADMIN_TOKEN)))
    return "admin";
  if (env.AGENT_TOKEN && env.AGENT_TOKEN.length >= 24 && (await sameSecret(token, env.AGENT_TOKEN)))
    return "agent";
  return null;
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return null;
  const raw = await readRequestText(request, 65536);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function fields(input: Record<string, unknown>, existing?: Task) {
  const title = input.title ?? existing?.title;
  const description = input.description ?? existing?.description ?? "";
  const project = input.project ?? existing?.project ?? "";
  const priority = input.priority ?? existing?.priority ?? "medium";
  const due = input.due_date === undefined ? (existing?.due_date ?? null) : input.due_date;
  const previousStatus =
    existing?.status === "todo" && existing.dispatch === "draft" ? "backlog" : existing?.status;
  let status = input.status ?? previousStatus ?? "backlog";
  // Older clients used dispatch=draft with status=todo. Preserve that request as backlog.
  if (input.dispatch === "draft" && status === "todo") status = "backlog";
  if (input.status === undefined && input.dispatch === "requested" && status === "backlog")
    status = "todo";
  const dispatch = status === "backlog" ? "draft" : "requested";
  const approval = input.approval_required ?? Boolean(existing?.approval_required);
  const dependencies: unknown =
    input.depends_on ?? (existing ? JSON.parse(existing.depends_on) : []);
  const dependsOn =
    Array.isArray(dependencies) &&
    dependencies.length <= 20 &&
    dependencies.every((value) => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value)) &&
    new Set(dependencies).size === dependencies.length &&
    !dependencies.includes(existing?.id)
      ? (dependencies as string[])
      : null;
  const preferences = preferencesSchema.safeParse({
    task_type: input.task_type ?? existing?.task_type ?? "general",
    agent_preference: input.agent_preference ?? existing?.agent_preference ?? "auto",
    model_preference: input.model_preference ?? existing?.model_preference ?? "auto",
    target_preference: input.target_preference ?? existing?.target_preference ?? "auto",
  });
  if (
    !validText(title, 160) ||
    !optionalText(description, 10000) ||
    !optionalText(project, 120) ||
    !oneOf(priority, priorities) ||
    !oneOf(status, statuses) ||
    !oneOf(dispatch, dispatches) ||
    !(
      due === null ||
      (typeof due === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(due) &&
        !Number.isNaN(Date.parse(due)) &&
        new Date(due).toISOString().slice(0, 10) === due)
    ) ||
    typeof approval !== "boolean" ||
    !dependsOn ||
    !preferences.success
  )
    return null;
  return {
    title: title.trim(),
    description,
    project: project.trim(),
    priority,
    due_date: due,
    status,
    dispatch,
    approval_required: Number(approval),
    depends_on: JSON.stringify(dependsOn),
    ...preferences.data,
  };
}

async function routingSettings(env: Env) {
  const row = await env.DB.prepare(
    "SELECT version,config_json FROM routing_settings WHERE id=1",
  ).first<{ version: number; config_json: string }>();
  const parsed = settingsSchema.safeParse(
    row ? JSON.parse(row.config_json) : { targets: [], agents: [], models: [], rules: [] },
  );
  if (!parsed.success) throw new Error("routing_settings_invalid");
  return { version: row?.version ?? 1, config: parsed.data };
}
// Retain legacy priority data for API compatibility, but never use it for execution.
const routeFor = (
  config: RoutingSettings,
  task: Pick<
    Task,
    | "task_type"
    | "agent_preference"
    | "model_preference"
    | "target_preference"
    | "priority"
    | "project"
  >,
) =>
  resolveRouting(
    { ...config, rules: config.rules.filter((rule) => rule.priority === "any") },
    task,
  );
const routeMessage = (route: ReturnType<typeof resolveRouting>) =>
  JSON.stringify({
    source: route.source,
    chosen_rule_id: route.chosen_rule_id,
    matched_rule_ids: route.matched_rule_ids,
    agent_id: route.candidate_agent_id,
    model_id: route.candidate_model_id,
    target_id: route.candidate_target_id,
    reasons: route.blocked_reasons,
    rationale_code: route.rationale_code,
  });

const event = (
  taskId: string,
  kind: string,
  message: string,
  url: string | null,
  actor: Role,
  attemptId: string | null,
  previousStatus: string | null,
  nextStatus: string | null,
) =>
  [
    crypto.randomUUID(),
    taskId,
    kind,
    message,
    url,
    actor,
    new Date().toISOString(),
    attemptId,
    previousStatus,
    nextStatus,
  ] as const;

const eventStatement = (env: Env, values: ReturnType<typeof event>, guard?: number | "changed") =>
  env.DB.prepare(
    "INSERT INTO task_events (id,task_id,kind,body,result_url,actor,created_at,attempt_id,previous_status,next_status) " +
      (guard === undefined
        ? "VALUES (?,?,?,?,?,?,?,?,?,?)"
        : guard === "changed"
          ? "SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes()>0"
          : "SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM tasks WHERE id=? AND version=?)"),
  ).bind(...values, ...(typeof guard === "number" ? [values[1], guard] : []));

async function getTask(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Task>();
}
const safeTask = (task: Task | null) => {
  if (!task) return null;
  const { claim_id: _claimId, claim_key: _claimKey, priority: _priority, ...visible } = task;
  return {
    ...visible,
    status: task.status === "todo" && task.dispatch === "draft" ? "backlog" : task.status,
    depends_on: JSON.parse(task.depends_on) as string[],
  };
};
const taskStatus = (task: Task) =>
  task.status === "todo" && task.dispatch === "draft" ? "backlog" : task.status;
type OrderRow = { status: string; version: number; ids_json: string };
async function taskOrders(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT status,version,ids_json FROM task_orders",
  ).all<OrderRow>();
  return new Map(
    rows.results.map((row) => [
      row.status,
      { version: row.version, ids: JSON.parse(row.ids_json) as string[] },
    ]),
  );
}
function sortedTasks(rows: Task[], orders: Awaited<ReturnType<typeof taskOrders>>) {
  const positions = new Map(
    [...orders].map(([status, order]) => [
      status,
      new Map(order.ids.map((id, index) => [id, index])),
    ]),
  );
  return rows.sort((a, b) => {
    const aStatus = taskStatus(a),
      bStatus = taskStatus(b);
    if (aStatus !== bStatus) return statuses.indexOf(aStatus) - statuses.indexOf(bStatus);
    const aPosition = positions.get(aStatus)?.get(a.id),
      bPosition = positions.get(bStatus)?.get(b.id);
    if (aPosition !== undefined || bPosition !== undefined)
      return (aPosition ?? Number.MAX_SAFE_INTEGER) - (bPosition ?? Number.MAX_SAFE_INTEGER);
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
}

async function api(
  request: Request,
  env: Env,
  role: Role,
  path: string,
  connectionId?: string,
): Promise<Response> {
  const method = request.method;
  // Only owner writes can attach a pending upload to a task. Knowing an image
  // UUID and adding it to an MCP-created description must not grant access.
  const bindTaskImages = (id: string, description: string) =>
    env.DB.prepare(
      "UPDATE task_images SET task_id=? WHERE task_id IS NULL AND id IN (SELECT value FROM json_each(?)) AND changes()>0",
    ).bind(id, JSON.stringify(taskImages(description).map((image) => image.id)));
  let pendingConnections: Promise<ConnectionState> | undefined;
  const getConnections = () => (pendingConnections ??= connectionState(env));
  const assignedTo = (task: Task, state: ConnectionState) =>
    task.mcp_connection_id ?? state.default_connection_id;
  const availableTo = (task: Task, state: ConnectionState) => {
    const assigned = assignedTo(task, state);
    return connectionId ? assigned === connectionId : assigned === null;
  };
  const assignmentFor = async (input: Record<string, unknown>, existing?: Task) => {
    if (existing && input.mcp_connection_id === undefined)
      return { id: existing.mcp_connection_id };
    const state = await getConnections();
    const id =
      input.mcp_connection_id === undefined || input.mcp_connection_id === null
        ? state.default_connection_id
        : input.mcp_connection_id;
    if (
      id !== null &&
      (!validConnectionId(id) ||
        !state.connections.some((item) => item.id === id && canExecute(item)))
    )
      return null;
    return { id: id as string | null };
  };
  if (path === "/api/board/revision" && method === "GET") {
    if (role !== "admin") return failure("操作できません", 403);
    const row = await env.DB.prepare("SELECT version FROM board_revision WHERE id=1").first<{
      version: number;
    }>();
    if (!row) return failure("更新情報を取得できません", 503);
    const etag = `"board-${row.version}"`;
    const headers = {
      etag: etag,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    if (request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers });
    return Response.json({ revision: row.version }, { headers });
  }
  if (path === "/api/me" && method === "GET") return json({ role });
  if (path === "/api/task-images" && method === "POST") {
    if (role !== "admin") return failure("操作できません", 403);
    const bytes = await readTaskImage(request);
    if (!bytes) return failure("画像を確認してください", 400, "image_upload_invalid");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO task_images (id,image,created_at) VALUES (?,?,?)")
      .bind(id, bytes.buffer, new Date().toISOString())
      .run();
    return json({ url: `/api/task-images/${id}` }, 201);
  }
  const imagePath = path.match(/^\/api\/task-images\/([0-9a-f-]{36})$/);
  const taskImagePath = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/images\/([0-9a-f-]{36})$/);
  if ((imagePath || taskImagePath) && method === "GET") {
    const imageId = imagePath?.[1] ?? taskImagePath![2];
    if (taskImagePath) {
      const task = await getTask(env, taskImagePath[1]);
      if (
        !task ||
        (role === "agent" &&
          (task.dispatch !== "requested" ||
            task.archived_at ||
            !availableTo(task, await getConnections())))
      )
        return failure("画像が見つかりません", 404);
      if (!taskImages(task.description).some((image) => image.id === imageId))
        return failure("画像が見つかりません", 404);
    } else if (role !== "admin") return failure("操作できません", 403);
    const image = await env.DB.prepare("SELECT image,task_id FROM task_images WHERE id=?")
      .bind(imageId)
      .first<{ image: number[]; task_id: string | null }>();
    if (!image || (taskImagePath && image.task_id !== taskImagePath[1]))
      return failure("画像が見つかりません", 404);
    return new Response(new Uint8Array(image.image), {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  }
  if (path === "/api/service-icons" && method === "POST") {
    if (role !== "admin") return failure("操作できません", 403);
    const bytes = await readProjectIcon(request);
    if (!bytes) return failure("アイコン画像を確認してください", 400, "icon_upload_invalid");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO project_icons (id,image,created_at) VALUES (?,?,?)")
      .bind(id, bytes.buffer, new Date().toISOString())
      .run();
    return json({ icon: `/api/service-icons/${id}` }, 201);
  }
  const iconPath = path.match(/^\/api\/service-icons\/([0-9a-f-]{36})$/);
  if (iconPath && method === "GET") {
    if (role !== "admin") return failure("操作できません", 403);
    const icon = await env.DB.prepare("SELECT image FROM project_icons WHERE id=?")
      .bind(iconPath[1])
      .first<{ image: number[] }>();
    if (!icon) return failure("アイコンが見つかりません", 404);
    return new Response(new Uint8Array(icon.image), {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  }
  if (path === "/api/services" && method === "POST") {
    if (role !== "admin") return failure("操作できません", 403);
    const parsed = serviceSchema.safeParse(await body(request));
    if (!parsed.success)
      return failure("プロジェクトの入力を確認してください", 400, "service_settings_invalid");
    const current = await routingSettings(env);
    const config = settingsSchema.safeParse({
      ...current.config,
      services: [...current.config.services, parsed.data],
    });
    if (!config.success)
      return failure(
        "登録済みのプロジェクト名、または登録数の上限です",
        400,
        "project_duplicate_or_limit",
      );
    const now = new Date().toISOString();
    const [result] = await env.DB.batch([
      env.DB.prepare(
        "UPDATE routing_settings SET config_json=?,version=version+1,updated_at=? WHERE id=1 AND version=?",
      ).bind(JSON.stringify(config.data), now, current.version),
      env.DB.prepare(
        "INSERT INTO routing_settings_events (version,created_at,summary) SELECT ?,?,? WHERE changes()>0",
      ).bind(current.version + 1, now, `services=${config.data.services.length}`),
    ]);
    if (!result.meta.changes) return failure("設定が競合しました", 409, "settings_conflict");
    return json(
      { service: parsed.data, config: publicSettings(config.data), version: current.version + 1 },
      201,
    );
  }
  if (path === "/api/settings" && role === "admin") {
    if (method === "GET") {
      const value = await routingSettings(env);
      const history = await env.DB.prepare(
        "SELECT version,created_at,summary FROM routing_settings_events ORDER BY version DESC LIMIT 30",
      ).all();
      return json({
        version: value.version,
        config: publicSettings(value.config),
        history: history.results,
      });
    }
    if (method === "PUT") {
      const input = await body(request);
      if (input && input.services === undefined)
        input.services = (await routingSettings(env)).config.services;
      const parsed = settingsSchema.safeParse(input);
      const version = Number(request.headers.get("if-match"));
      if (!parsed.success || !Number.isInteger(version) || version < 1)
        return failure("設定または版番号が不正です", 400, "settings_invalid");
      const now = new Date().toISOString();
      const [result] = await env.DB.batch([
        env.DB.prepare(
          "UPDATE routing_settings SET config_json=?,version=version+1,updated_at=? WHERE id=1 AND version=?",
        ).bind(JSON.stringify(parsed.data), now, version),
        env.DB.prepare(
          "INSERT INTO routing_settings_events (version,created_at,summary) SELECT ?,?,? WHERE changes()>0",
        ).bind(
          version + 1,
          now,
          `services=${parsed.data.services.length},targets=${parsed.data.targets.length},agents=${parsed.data.agents.length},models=${parsed.data.models.length},rules=${parsed.data.rules.length}`,
        ),
      ]);
      if (!result.meta.changes) return failure("設定が競合しました", 409, "settings_conflict");
      return json({ version: version + 1, config: publicSettings(parsed.data) });
    }
  }
  if (path === "/api/routing" && method === "GET") {
    const value = await routingSettings(env);
    return json({
      version: value.version,
      config: publicSettings(value.config),
      external_dispatch_connected: false,
    });
  }
  if (path === "/api/routing/preview" && method === "POST") {
    const input = await body(request);
    const parsed = preferencesSchema.safeParse({
      task_type: input?.task_type,
      agent_preference: input?.agent_preference,
      model_preference: input?.model_preference,
      target_preference: input?.target_preference,
    });
    if (
      !input ||
      !parsed.success ||
      !oneOf(input.priority, priorities) ||
      !optionalText(input.project, 120)
    )
      return failure("プレビュー入力が不正です", 400, "preview_invalid");
    const override = input.config === undefined ? null : settingsSchema.safeParse(input.config);
    if (override && !override.success) return failure("設定が不正です", 400, "settings_invalid");
    const value = await routingSettings(env);
    return json({
      routing: resolveRouting(override ? override.data : value.config, {
        ...parsed.data,
        priority: input.priority,
        project: input.project,
      }),
    });
  }
  if (path === "/api/events/drain" && method === "POST" && role === "admin")
    return json(await drainOutbox(env, request));
  if (path === "/api/tasks/reorder" && method === "POST" && role === "admin") {
    const input = await body(request);
    const status = input?.status,
      id = input?.id,
      beforeId = input?.before_id,
      taskVersion = input?.task_version;
    const version = Number(request.headers.get("if-match"));
    if (
      !oneOf(status, statuses) ||
      typeof id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(id) ||
      !(beforeId === null || (typeof beforeId === "string" && /^[0-9a-f-]{36}$/.test(beforeId))) ||
      typeof taskVersion !== "number" ||
      !Number.isInteger(taskVersion) ||
      taskVersion < 1 ||
      !Number.isInteger(version) ||
      version < 1
    )
      return failure("並び替えの入力が不正です", 400);
    const orders = await taskOrders(env),
      order = orders.get(status);
    if (!order || order.version !== version)
      return failure("並び順が変更されました。再読み込みしてください", 409);
    const rows = await env.DB.prepare("SELECT * FROM tasks").all<Task>();
    const current = sortedTasks(
      rows.results.filter((task) => taskStatus(task) === status && !task.archived_at),
      orders,
    );
    const source = current.find((task) => task.id === id);
    if (
      !source ||
      source.version !== taskVersion ||
      (beforeId && !current.some((task) => task.id === beforeId))
    )
      return failure("タスクが変更されました。再読み込みしてください", 409);
    const ids = current.map((task) => task.id).filter((value) => value !== id);
    const beforeIndex = beforeId === null ? -1 : ids.indexOf(beforeId as string);
    ids.splice(beforeIndex < 0 ? ids.length : beforeIndex, 0, id);
    if (ids.every((value, index) => value === current[index]?.id)) return json({ version, ids });
    const update = env.DB.prepare(
      "UPDATE task_orders SET ids_json=?,version=version+1 WHERE status=? AND version=? AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND version=? AND archived_at IS NULL AND (CASE WHEN status='todo' AND dispatch='draft' THEN 'backlog' ELSE status END)=?)",
    ).bind(JSON.stringify(ids), status, version, id, taskVersion, status);
    const [result] = await env.DB.batch([
      update,
      eventStatement(
        env,
        event(id, "reordered", "並び順を変更", null, role, null, status, status),
        "changed",
      ),
    ]);
    if (!result.meta.changes) return failure("並び順が変更されました。再読み込みしてください", 409);
    return json({ version: version + 1, ids });
  }
  if (path === "/api/tasks/archive" && method === "POST" && role === "admin") {
    const input = await body(request);
    const all = input?.all === true;
    const entries = input?.tasks;
    if (
      !input ||
      (all && entries !== undefined) ||
      (!all &&
        (!Array.isArray(entries) ||
          entries.length < 1 ||
          entries.length > 100 ||
          entries.some(
            (item) =>
              !item ||
              typeof item !== "object" ||
              !("id" in item) ||
              typeof item.id !== "string" ||
              !/^[0-9a-f-]{36}$/.test(item.id) ||
              !("version" in item) ||
              !Number.isInteger(item.version) ||
              item.version < 1,
          ) ||
          new Set(entries.map((item) => item.id)).size !== entries.length))
    )
      return failure("アーカイブ対象が不正です", 400);
    const now = new Date().toISOString();
    const chosen = all ? null : (entries as { id: string; version: number }[]);
    const selection = chosen ? JSON.stringify(chosen) : null;
    const condition =
      "status='done' AND archived_at IS NULL" +
      (chosen
        ? " AND EXISTS (SELECT 1 FROM json_each(?) AS entry WHERE tasks.id=json_extract(entry.value,'$.id') AND tasks.version=json_extract(entry.value,'$.version')) AND (SELECT COUNT(*) FROM tasks AS t JOIN json_each(?) AS entry ON t.id=json_extract(entry.value,'$.id') AND t.version=json_extract(entry.value,'$.version') WHERE t.status='done' AND t.archived_at IS NULL)=?"
        : "");
    const parameters = chosen ? [selection, selection, chosen.length] : [];
    // Select audit rows before the update, inside the same transaction. This captures
    // exactly the rows being archived, without per-task reads or excessive SQL parameters.
    const [, result] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO task_events (id,task_id,kind,body,result_url,actor,created_at,attempt_id,previous_status,next_status) SELECT ? || id,id,'archived','アーカイブに移動',NULL,?,?,NULL,'done','done' FROM tasks WHERE ${condition}`,
      ).bind(crypto.randomUUID() + ":", role, now, ...parameters),
      env.DB.prepare(
        `UPDATE tasks SET archived_at=?,version=version+1,updated_at=? WHERE ${condition} RETURNING id`,
      ).bind(now, now, ...parameters),
    ]);
    if (chosen && result.results.length !== chosen.length)
      return failure("対象が変更されました。再読み込みしてください", 409);
    return json({ archived: result.results.length });
  }
  if (path === "/api/tasks/unarchive" && method === "POST" && role === "admin") {
    const input = await body(request);
    const id = input?.id,
      version = input?.version;
    if (
      typeof id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(id) ||
      !Number.isInteger(version) ||
      Number(version) < 1
    )
      return failure("復元対象が不正です", 400);
    const update = env.DB.prepare(
      "UPDATE tasks SET archived_at=NULL,version=version+1,updated_at=? WHERE id=? AND version=? AND status='done' AND archived_at IS NOT NULL",
    ).bind(new Date().toISOString(), id, version);
    const [result] = await env.DB.batch([
      update,
      eventStatement(
        env,
        event(id, "unarchived", "アーカイブから復元", null, role, null, "done", "done"),
        "changed",
      ),
    ]);
    if (!result.meta.changes) return failure("対象が変更されました。再読み込みしてください", 409);
    return json({ task: safeTask(await getTask(env, id)) });
  }
  if (path === "/api/tasks/next" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT * FROM tasks WHERE dispatch='requested' AND status!='done' AND archived_at IS NULL",
    ).all<Task>();
    const allStatuses = await env.DB.prepare("SELECT id,status FROM tasks").all<{
      id: string;
      status: string;
    }>();
    const statuses = new Map(allStatuses.results.map((item) => [item.id, item.status]));
    const settings = await routingSettings(env);
    const state = role === "agent" ? await getConnections() : null;
    const skipped: { id: string; reasons: string[] }[] = [];
    let nextTask: Task | null = null;
    for (const task of sortedTasks(rows.results, await taskOrders(env))) {
      if (state && !availableTo(task, state)) continue;
      const reasons: string[] = [];
      if (task.status !== "todo") reasons.push(`status_${task.status}`);
      if (task.approval_required) reasons.push("approval_required");
      for (const dependency of JSON.parse(task.depends_on) as string[])
        if (statuses.get(dependency) !== "done")
          reasons.push(`dependency_unresolved:${dependency}`);
      reasons.push(...routeFor(settings.config, task).blocked_reasons);
      if (reasons.length) skipped.push({ id: task.id, reasons });
      else if (!nextTask) nextTask = task;
    }
    return json({
      task: nextTask
        ? { ...safeTask(nextTask), routing: routeFor(settings.config, nextTask) }
        : null,
      waiting: !nextTask,
      skipped,
    });
  }
  if (path === "/api/tasks" && method === "GET") {
    const archived = new URL(request.url).searchParams.get("archived") === "1";
    const where =
      role === "agent"
        ? "WHERE dispatch = 'requested' AND archived_at IS NULL"
        : archived
          ? "WHERE archived_at IS NOT NULL"
          : "WHERE archived_at IS NULL";
    const state = role === "agent" ? await getConnections() : null;
    const assignmentFilter = state ? " AND COALESCE(mcp_connection_id, ?) IS ?" : "";
    const query = env.DB.prepare(`SELECT * FROM tasks ${where}${assignmentFilter}`);
    const rows = await (
      state ? query.bind(state.default_connection_id, connectionId ?? null) : query
    ).all<Task>();
    const archivedCount =
      role === "admin"
        ? await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM tasks WHERE archived_at IS NOT NULL",
          ).first<{ count: number }>()
        : null;
    const settings = await routingSettings(env);
    const orders = await taskOrders(env);
    return json({
      tasks: sortedTasks(
        state ? rows.results.filter((task) => availableTo(task, state)) : rows.results,
        orders,
      )
        .slice(0, 500)
        .map((task) => ({ ...safeTask(task), routing: routeFor(settings.config, task) })),
      archived_count: archivedCount?.count ?? 0,
      order_versions: Object.fromEntries(
        [...orders].map(([status, order]) => [status, order.version]),
      ),
    });
  }
  if (path === "/api/tasks" && method === "POST" && (role === "admin" || connectionId)) {
    const input = await body(request);
    const data = input && fields(input);
    if (!data || !["backlog", "todo"].includes(data.status))
      return failure("入力を確認してください", 400);
    // MCP-created work always belongs to the caller, independent of the board default.
    const assignment = await assignmentFor(
      role === "agent" ? { mcp_connection_id: connectionId } : input!,
    );
    if (!assignment)
      return failure(
        "接続済みの実行可能なエージェントを選んでください",
        400,
        "connection_unavailable",
      );
    let id: string = crypto.randomUUID();
    const now = new Date().toISOString();
    if (role === "agent") {
      const key = request.headers.get("idempotency-key");
      if (!key || !/^[a-zA-Z0-9_-]{12,128}$/.test(key))
        return failure("登録の冪等キーが必要です", 400);
      const hash = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`mcp-create:${connectionId}:${key}`),
        ),
      );
      hash[6] = (hash[6] & 15) | 64;
      hash[8] = (hash[8] & 63) | 128;
      const hex = Array.from(hash.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
      id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    const retryResult = async () => {
      const existing = await getTask(env, id);
      if (!existing) return null;
      if (existing.archived_at || existing.mcp_connection_id !== connectionId)
        return failure("登録済みタスクの担当または公開状態が変更されています", 409);
      return json({
        task: {
          ...safeTask(existing),
          routing: routeFor((await routingSettings(env)).config, existing),
        },
      });
    };
    if (role === "agent") {
      const retry = await retryResult();
      if (retry) return retry;
    }
    const settings = await routingSettings(env),
      route = routeFor(settings.config, data);
    const initialStatus =
      data.status === "todo" && route.blocked_reasons.length ? "review" : "todo";
    const insert = env.DB.prepare(
      "INSERT INTO tasks (id,title,description,project,priority,due_date,status,dispatch,approval_required,task_type,agent_preference,model_preference,target_preference,depends_on,created_at,updated_at,mcp_connection_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      data.title,
      data.description,
      data.project,
      data.priority,
      data.due_date,
      initialStatus,
      data.dispatch,
      data.approval_required,
      data.task_type,
      data.agent_preference,
      data.model_preference,
      data.target_preference,
      data.depends_on,
      now,
      now,
      assignment.id,
    );
    const e = event(
      id,
      "created",
      data.status === "backlog" ? "バックログに作成" : "未着手に作成",
      null,
      role,
      null,
      null,
      data.status,
    );
    try {
      await env.DB.batch([
        insert,
        ...(role === "admin" ? [bindTaskImages(id, data.description)] : []),
        eventStatement(env, e),
        eventStatement(
          env,
          event(id, "routing", routeMessage(route), null, role, null, null, initialStatus),
        ),
        ...(env.EVENTS_ENABLED === "true" && data.status === "todo" && initialStatus === "todo"
          ? [readyStatement(env, id, 1, e[0])]
          : []),
      ]);
    } catch (error) {
      // Concurrent retries race on the deterministic task ID; the losing batch rolls back.
      if (role === "agent") {
        const retry = await retryResult();
        if (retry) return retry;
      }
      throw error;
    }
    return json({ task: { ...safeTask(await getTask(env, id)), routing: route } }, 201);
  }
  const match = path.match(
    /^\/api\/tasks\/([0-9a-f-]{36})(?:\/(claim|resume|renew|events|status))?$/,
  );
  if (!match) return failure("見つかりません", 404);
  const id = match[1],
    action = match[2];
  const current = await getTask(env, id);
  if (
    !current ||
    (role === "agent" &&
      (current.archived_at ||
        (current.dispatch !== "requested" &&
          action !== "status" &&
          !(!action && method === "GET"))))
  )
    return failure("見つかりません", 404);
  if (role === "agent" && !availableTo(current, await getConnections()))
    return failure("この接続には割り当てられていません", 403, "connection_mismatch");
  if (!action && method === "GET") {
    const events = await env.DB.prepare(
      "SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC",
    )
      .bind(id)
      .all();
    const settings = await routingSettings(env);
    return json({
      task: { ...safeTask(current), routing: routeFor(settings.config, current) },
      events: events.results,
    });
  }
  if (!action && method === "PATCH" && role === "admin") {
    if (current.archived_at) return failure("アーカイブ済みのタスクを復元してください", 409);
    const input = await body(request);
    const data = input && fields(input, current);
    const version = Number(request.headers.get("if-match"));
    if (!data || !Number.isInteger(version) || version < 1)
      return failure("入力または版番号が不正です", 400);
    const assignment = await assignmentFor(input!, current);
    if (!assignment)
      return failure(
        "接続済みの実行可能なエージェントを選んでください",
        400,
        "connection_unavailable",
      );
    if (current.status === "in_progress" && assignment.id !== current.mcp_connection_id)
      return failure("実行中の担当は変更できません", 409, "assignment_in_progress");
    if (
      current.status === "in_progress" &&
      (data.dispatch !== current.dispatch ||
        data.status !== current.status ||
        data.depends_on !== current.depends_on)
    )
      return failure("実行中の状態は進捗 API で更新してください", 409);
    if (data.status === "in_progress" && current.status !== "in_progress")
      return failure("着手には claim API を使ってください", 400);
    const settings = await routingSettings(env),
      route = routeFor(settings.config, data);
    const nextStatus =
      data.status === "backlog"
        ? "todo"
        : data.status === "todo" && route.blocked_reasons.length
          ? "review"
          : data.status;
    const now = new Date().toISOString();
    const update = env.DB.prepare(
      "UPDATE tasks SET title=?,description=?,project=?,priority=?,due_date=?,status=?,dispatch=?,approval_required=?,task_type=?,agent_preference=?,model_preference=?,target_preference=?,depends_on=?,mcp_connection_id=?,version=version+1,updated_at=? WHERE id=? AND version=?",
    ).bind(
      data.title,
      data.description,
      data.project,
      data.priority,
      data.due_date,
      nextStatus,
      data.dispatch,
      data.approval_required,
      data.task_type,
      data.agent_preference,
      data.model_preference,
      data.target_preference,
      data.depends_on,
      assignment.id,
      now,
      id,
      version,
    );
    const requeued = ["review", "stopped"].includes(current.status) && nextStatus === "todo";
    const e = event(
      id,
      requeued ? "requeued" : "updated",
      requeued ? "未着手に戻しました" : "タスクを編集",
      null,
      role,
      current.claim_id,
      current.status === "todo" && current.dispatch === "draft" ? "backlog" : current.status,
      data.status === "backlog" ? "backlog" : nextStatus,
    );
    const results = await env.DB.batch([
      eventStatement(env, e, version),
      eventStatement(
        env,
        event(
          id,
          "routing",
          routeMessage(route),
          null,
          role,
          current.claim_id,
          taskStatus(current),
          data.status === "backlog" ? "backlog" : nextStatus,
        ),
        version,
      ),
      update,
      bindTaskImages(id, data.description),
      ...(env.EVENTS_ENABLED === "true" &&
      (current.dispatch === "draft" || current.status !== "todo") &&
      data.status === "todo" &&
      nextStatus === "todo"
        ? [readyStatement(env, id, version + 1, e[0])]
        : []),
    ]);
    if (!results[2].meta.changes)
      return failure("他の更新と競合しました。再読み込みしてください", 409);
    return json({ task: { ...safeTask(await getTask(env, id)), routing: route } });
  }
  // Status changes are independent of execution; only starting/running work needs a lease.
  const statusInput =
    action === "status" && method === "POST" && role === "agent" ? await body(request) : null;
  if (action === "status" && method === "POST" && role === "agent") {
    const input = statusInput;
    const version = Number(request.headers.get("if-match"));
    if (
      !input ||
      !oneOf(input.status, statuses) ||
      !validText(input.message, 4000) ||
      !Number.isInteger(version) ||
      version < 1 ||
      !(input.result_url == null || validResultUrl(input.result_url)) ||
      (input.approval_confirmed !== undefined && typeof input.approval_confirmed !== "boolean")
    )
      return failure("入力を確認してください", 400);
    // A fresh start uses the atomic claim flow below. An existing lease can record the same status.
    if (
      input.status !== "in_progress" ||
      (current.status === "in_progress" && current.claim_id && input.claim_id === current.claim_id)
    ) {
      const now = new Date().toISOString();
      if (
        current.status === "in_progress" &&
        (!current.claim_id ||
          input.claim_id !== current.claim_id ||
          !current.lease_expires_at ||
          current.lease_expires_at <= now)
      )
        return failure("有効な lease が必要です", 409);
      if (input.status === "done" && current.approval_required && input.approval_confirmed !== true)
        return failure(
          "ユーザーの承認を確認し、approval_confirmed=trueと承認範囲を指定してください",
          409,
        );
      const target = input.status;
      const claim = target === "in_progress" ? current.claim_id : null;
      const e = event(
        id,
        "progress",
        `${input.approval_confirmed === true ? "承認確認済み: " : ""}${String(input.message).trim()}`,
        (input.result_url as string) ?? null,
        role,
        current.claim_id,
        taskStatus(current),
        target,
      );
      const [result] = await env.DB.batch([
        env.DB.prepare(
          "UPDATE tasks SET status=?,dispatch=?,claim_id=?,lease_expires_at=?,approval_required=?,version=version+1,updated_at=? WHERE id=? AND version=?",
        ).bind(
          target === "backlog" ? "todo" : target,
          target === "backlog" ? "draft" : "requested",
          claim,
          claim ? current.lease_expires_at : null,
          target === "done" && input.approval_confirmed === true ? 0 : current.approval_required,
          now,
          id,
          version,
        ),
        env.DB.prepare(
          "INSERT INTO task_events (id,task_id,kind,body,result_url,actor,created_at,attempt_id,previous_status,next_status) SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes()>0",
        ).bind(...e),
        ...(env.EVENTS_ENABLED === "true" && target === "todo"
          ? [readyStatement(env, id, version + 1, e[0])]
          : []),
      ]);
      if (!result.meta.changes) return failure("他の更新と競合しました。再取得してください", 409);
      return json({
        task: safeTask(await getTask(env, id)),
        ...(claim ? { claim_id: claim } : {}),
      });
    }
  }
  if (
    (action === "claim" || action === "resume" || action === "status") &&
    method === "POST" &&
    role === "agent"
  ) {
    const resuming = action !== "claim";
    const input = action === "status" ? statusInput : resuming ? await body(request) : null;
    if (
      resuming &&
      (!input ||
        !validText(input.message, 4000) ||
        (input.approval_confirmed !== undefined && typeof input.approval_confirmed !== "boolean"))
    )
      return failure("再開理由を指定してください", 400);
    const version = Number(request.headers.get("if-match"));
    const key = request.headers.get("idempotency-key");
    if (!Number.isInteger(version) || version < 1 || !key || !/^[a-zA-Z0-9_-]{12,128}$/.test(key))
      return failure("版番号と冪等キーが必要です", 400);
    if (current.claim_key === key && current.claim_id && current.status === "in_progress") {
      if (!current.lease_expires_at || current.lease_expires_at <= new Date().toISOString())
        return failure("lease が失効しました。再実行は手動で確認してください", 409);
      return json({ task: safeTask(current), claim_id: current.claim_id });
    }
    if (current.version !== version)
      return failure("他の更新と競合しました。再取得してください", 409);
    if (
      resuming &&
      (current.status === "in_progress" ||
        current.claim_key === key ||
        (action === "resume" && !["review", "stopped"].includes(current.status)))
    )
      return failure("実行中以外のタスクに、新しい冪等キーで着手・再開を指定してください", 409);
    if (resuming && current.approval_required && input?.approval_confirmed !== true)
      return failure(
        "ユーザーの承認を確認し、approval_confirmed=trueと承認範囲を再開理由に指定してください",
        409,
      );
    const settings = await routingSettings(env),
      route = routeFor(settings.config, current);
    const unresolved = await env.DB.prepare(
      "SELECT 1 AS blocked FROM json_each(?) AS dep LEFT JOIN tasks AS parent ON parent.id=dep.value WHERE parent.status IS NULL OR parent.status!='done' LIMIT 1",
    )
      .bind(current.depends_on)
      .first();
    if (unresolved) return failure("依存タスクが完了していません", 409, "dependency_unresolved");
    if (route.blocked_reasons.length) {
      if (current.status === "todo" && current.dispatch === "requested") {
        await env.DB.batch([
          eventStatement(
            env,
            event(id, "routing", routeMessage(route), null, "agent", null, "todo", "review"),
            current.version,
          ),
          env.DB.prepare(
            "UPDATE tasks SET status='review',version=version+1,updated_at=? WHERE id=? AND version=? AND status='todo'",
          ).bind(new Date().toISOString(), id, current.version),
        ]);
      }
      return failure("割り当てを確認してください", 409, "routing_blocked");
    }
    const claimId = crypto.randomUUID(),
      now = new Date().toISOString(),
      expires = new Date(Date.now() + 15 * 60_000).toISOString();
    const e = event(
      id,
      resuming ? "resumed" : "claimed",
      resuming
        ? `${input?.approval_confirmed === true ? "承認確認済み: " : ""}${String(input!.message).trim()}`
        : "エージェントが着手",
      (input?.result_url as string) ?? null,
      role,
      claimId,
      taskStatus(current),
      "in_progress",
    );
    const [result] = await env.DB.batch([
      env.DB.prepare(
        "UPDATE tasks SET status='in_progress',dispatch='requested',claim_id=?,claim_key=?,lease_expires_at=?,mcp_connection_id=?,approval_required=?,version=version+1,updated_at=? WHERE id=? AND version=? AND dispatch=? AND status=? AND claim_id IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(tasks.depends_on) AS dep LEFT JOIN tasks AS parent ON parent.id=dep.value WHERE parent.status IS NULL OR parent.status!='done')",
      ).bind(
        claimId,
        key,
        expires,
        connectionId ?? null,
        resuming && input?.approval_confirmed === true ? 0 : current.approval_required,
        now,
        id,
        version,
        action === "status" ? current.dispatch : "requested",
        resuming ? current.status : "todo",
      ),
      env.DB.prepare(
        "INSERT INTO task_events (id,task_id,kind,body,result_url,actor,created_at,attempt_id,previous_status,next_status) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM tasks WHERE id=? AND claim_id=? AND version=?)",
      ).bind(...e, id, claimId, version + 1),
    ]);
    if (!result.meta.changes) {
      const latest = await getTask(env, id);
      if (
        latest?.claim_key === key &&
        latest.claim_id &&
        latest.status === "in_progress" &&
        latest.lease_expires_at &&
        latest.lease_expires_at > new Date().toISOString() &&
        availableTo(latest, await getConnections())
      )
        return json({ task: safeTask(latest), claim_id: latest.claim_id });
      return failure("取得済みか、他の更新と競合しました", 409);
    }
    return json({ task: safeTask(await getTask(env, id)), claim_id: claimId });
  }
  if (action === "renew" && method === "POST" && role === "agent") {
    const input = await body(request);
    const version = Number(request.headers.get("if-match"));
    if (!Number.isInteger(version) || version < 1) return failure("版番号が不正です", 400);
    if (
      !input ||
      input.claim_id !== current.claim_id ||
      !current.claim_id ||
      current.status !== "in_progress" ||
      !current.lease_expires_at ||
      current.lease_expires_at <= new Date().toISOString()
    )
      return failure("有効な lease がありません。再実行は手動で確認してください", 409);
    const expires = new Date(Date.now() + 15 * 60_000).toISOString();
    const result = await env.DB.prepare(
      "UPDATE tasks SET lease_expires_at=?,version=version+1,updated_at=? WHERE id=? AND version=? AND claim_id=? AND lease_expires_at>?",
    )
      .bind(
        expires,
        new Date().toISOString(),
        id,
        version,
        current.claim_id,
        new Date().toISOString(),
      )
      .run();
    if (!result.meta.changes) return failure("他の更新と競合しました", 409);
    return json({ task: safeTask(await getTask(env, id)) });
  }
  if (action === "events" && method === "POST") {
    if (current.archived_at) return failure("アーカイブ済みのタスクを復元してください", 409);
    const input = await body(request);
    const version = Number(request.headers.get("if-match"));
    const message = input?.message,
      resultUrl = input?.result_url ?? null,
      nextStatus = input?.status ?? null;
    if (
      !input ||
      !validText(message, 4000) ||
      !Number.isInteger(version) ||
      version < 1 ||
      !(resultUrl === null || validResultUrl(resultUrl)) ||
      !(nextStatus === null || oneOf(nextStatus, statuses)) ||
      nextStatus === "backlog" ||
      nextStatus === "todo" ||
      nextStatus === "in_progress"
    )
      return failure("入力を確認してください", 400);
    if (
      role === "agent" &&
      (input.claim_id !== current.claim_id ||
        !current.claim_id ||
        current.status !== "in_progress" ||
        !current.lease_expires_at ||
        current.lease_expires_at <= new Date().toISOString())
    )
      return failure("有効な lease が必要です", 409);
    if (role === "agent" && nextStatus === "done" && current.approval_required)
      return failure("確認待ちにしてください", 409);
    const target = nextStatus ?? current.status,
      now = new Date().toISOString();
    const claim = target === "in_progress" ? current.claim_id : null;
    const update = env.DB.prepare(
      "UPDATE tasks SET status=?,claim_id=?,lease_expires_at=?,version=version+1,updated_at=? WHERE id=? AND version=?",
    ).bind(target, claim, claim ? current.lease_expires_at : null, now, id, version);
    const e = event(
      id,
      "progress",
      message.trim(),
      resultUrl,
      role,
      current.claim_id,
      current.status,
      target,
    );
    const [, result] = await env.DB.batch([eventStatement(env, e, version), update]);
    if (!result.meta.changes) return failure("他の更新と競合しました。再取得してください", 409);
    return json({ task: safeTask(await getTask(env, id)) });
  }
  return failure("操作できません", 403);
}

const boardHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!accessConfigured(env, request)) return failure("Access の所有者設定がありません", 503);
    if (!(await accessOwner(request, env))) return failure("Access の本人認証が必要です", 403);
    if (!url.pathname.startsWith("/api/")) {
      const appRoute =
        ["/settings", "/projects", "/connections"].includes(url.pathname) ||
        /^\/tasks\/(?:new|[0-9a-f-]{36})$/.test(url.pathname);
      const asset = await env.ASSETS.fetch(
        appRoute ? new Request(new URL("/", request.url), request) : request,
      );
      const headers = new Headers(asset.headers);
      headers.set(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      headers.set("referrer-policy", "no-referrer");
      headers.set("x-content-type-options", "nosniff");
      if (
        asset.headers.get("content-type")?.includes("text/html") ||
        url.pathname === "/" ||
        url.pathname === "/sw.js"
      )
        headers.set("cache-control", "private, no-store");
      return new Response(asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      });
    }
    if (!env.DB) return failure("D1 が設定されていません", 503);
    if (env.ADMIN_TOKEN && env.AGENT_TOKEN && env.ADMIN_TOKEN === env.AGENT_TOKEN)
      return failure("認証設定がありません", 503);
    const role = await roleFor(request, env);
    if (!role) return failure("認証が必要です", 401);
    // A browser uses the Access session without a bearer token. Require a same-origin
    // Origin on its writes so another site cannot submit requests with that session.
    if (
      !request.headers.has("authorization") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      if (request.headers.get("origin") !== url.origin)
        return failure("同一オリジンから操作してください", 403);
    }
    try {
      return await api(request, env, role, url.pathname);
    } catch {
      console.error(JSON.stringify({ error: "api_failure" }));
      return failure("処理に失敗しました", 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(drainOutbox(env, new Request("http://localhost/events/drain")));
  },
} satisfies ExportedHandler<Env>;

const oauthUserId = (env: Env) => encodeURIComponent((env.ACCESS_OWNER_EMAIL || "").toLowerCase());

async function authorize(request: Request, env: Env): Promise<Response> {
  if (!accessConfigured(env, request)) return failure("Access の所有者設定がありません", 503);
  if (!(await accessOwner(request, env))) return failure("Access の本人認証が必要です", 403);
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth || !allowedRedirects(env).length) return failure("OAuth 設定がありません", 503);
  let stage = "parse";
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      stage = "describe";
      if (
        !isAllowedRedirect(authRequest.redirectUri, env) ||
        authRequest.codeChallengeMethod !== "S256" ||
        !authRequest.codeChallenge ||
        !authRequest.scope.includes("tasks:read")
      )
        return new Response(
          renderConsentError(
            "許可されていない接続要求です。接続元のアプリからやり直してください。",
          ),
          { status: 400, headers: consentHeaders },
        );
      const details = await oauth.describeConsent(authRequest);
      stage = "begin_consent";
      const consent = await oauth.beginConsent(authRequest);
      const html = renderConsentPage(details, consent.handle);
      consent.headers.set("content-type", consentHeaders["content-type"]);
      consent.headers.set("cache-control", "no-store");
      consent.headers.set(
        "content-security-policy",
        consentRedirectPolicy(authRequest.redirectUri),
      );
      return new Response(html, { headers: consent.headers });
    }
    if (request.method === "POST") {
      if (request.headers.get("origin") !== new URL(request.url).origin)
        return failure("同一オリジンから操作してください", 403);
      const form = await request.formData();
      const handle = String(form.get("handle") || "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const selectedScopes = form.getAll("scope").map(String);
      if (!selectedScopes.includes("tasks:read")) return failure("読み取り権限が必要です", 400);
      stage = "approve_consent";
      const approved = await oauth.approveConsent(request, handle, { scope: selectedScopes });
      if (
        !isAllowedRedirect(approved.request.redirectUri, env) ||
        approved.request.codeChallengeMethod !== "S256" ||
        !approved.request.codeChallenge ||
        !approved.request.scope.includes("tasks:read") ||
        selectedScopes.some((scope) => !approved.request.scope.includes(scope))
      )
        return failure("許可されていない接続要求です", 400);
      stage = "complete_authorization";
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: oauthUserId(env),
        scope: selectedScopes,
        metadata: { clientName: (await oauth.describeConsent(approved.request)).clientName },
        props: { ownerEmail: env.ACCESS_OWNER_EMAIL?.toLowerCase() },
      });
      await connectionState(env);
      approved.headers.set(
        "content-security-policy",
        consentRedirectPolicy(approved.request.redirectUri),
      );
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const reasons: Record<string, string> = {
        "Invalid client_id": "client_unknown",
        "Invalid redirect URI": "redirect_invalid",
        "Client ID is required": "client_missing",
        "This authorization was not started in this browser; start again": "consent_cookie_missing",
        "This authorization belongs to a different browser session; start again":
          "consent_cookie_mismatch",
        "This authorization expired or was already used; start again": "consent_expired_or_used",
      };
      const reason =
        error instanceof AuthorizationError ? reasons[error.description] || "other" : "cimd_fetch";
      console.warn(
        JSON.stringify({
          error: "oauth_authorize_rejected",
          method: request.method,
          stage,
          code: error instanceof AuthorizationError ? error.code : "cimd_fetch",
          reason,
        }),
      );
      if (error instanceof AuthorizationError && error.redirectTo)
        return Response.redirect(error.redirectTo, 302);
      const expiredConsent =
        stage === "approve_consent" &&
        ["consent_cookie_missing", "consent_cookie_mismatch", "consent_expired_or_used"].includes(
          reason,
        );
      return new Response(
        renderConsentError(
          expiredConsent
            ? "接続要求の有効期限が切れたか、このブラウザで開始されていません。プラグイン詳細から接続をやり直してください。"
            : "接続元のアプリから、もう一度接続をやり直してください。",
        ),
        { status: 400, headers: consentHeaders },
      );
    }
    console.error(JSON.stringify({ error: "oauth_authorize_failure" }));
    return failure("接続処理に失敗しました", 500);
  }
}

async function connections(request: Request, env: Env): Promise<Response> {
  if (!accessConfigured(env, request) || !(await accessOwner(request, env)))
    return failure("Access の本人認証が必要です", 403);
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return failure("OAuth 設定がありません", 503);
  const url = new URL(request.url);
  if (url.pathname === "/api/connections" && request.method === "GET")
    return json(await connectionState(env));
  if (url.pathname === "/api/connections/default" && request.method === "PUT") {
    if (request.headers.get("origin") !== url.origin)
      return failure("同一オリジンから操作してください", 403);
    const input = await body(request),
      version = Number(request.headers.get("if-match"));
    const state = await connectionState(env);
    if (
      !input ||
      !validConnectionId(input.connection_id) ||
      !state.connections.some((item) => item.id === input.connection_id && canExecute(item))
    )
      return failure(
        "接続済みの実行可能なエージェントを選んでください",
        400,
        "connection_unavailable",
      );
    if (!Number.isInteger(version) || version < 1) return failure("版番号が必要です", 400);
    const changed = await env.DB.prepare(
      "UPDATE mcp_preferences SET default_connection_id=?,version=version+1 WHERE id=1 AND version=?",
    )
      .bind(input.connection_id, version)
      .run();
    if (!changed.meta.changes) return failure("設定が競合しました", 409, "settings_conflict");
    return json(await connectionState(env));
  }
  const match = url.pathname.match(/^\/api\/connections\/([a-zA-Z0-9_-]+)$/);
  if (match && request.method === "DELETE") {
    if (request.headers.get("origin") !== url.origin)
      return failure("同一オリジンから操作してください", 403);
    await oauth.revokeGrant(match[1], oauthUserId(env));
    return json({ revoked: true });
  }
  return failure("見つかりません", 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (
      !env.OAUTH_KV ||
      !env.OAUTH_RESOURCE ||
      !allowedRedirects(env).length ||
      env.OAUTH_RESOURCE !== `${url.origin}/mcp`
    )
      return failure("OAuth 設定がありません", 503);
    if (
      request.method === "POST" &&
      ["/oauth/register", "/oauth/token", "/authorize"].includes(url.pathname)
    ) {
      const bytes = await readRequestBytes(request, 65536);
      if (bytes === null) return failure("要求が大きすぎます", 413);
      request = new Request(request, { body: bytes });
    }
    const provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: {
        async fetch(req: Request, workerEnv: Env, context: ExecutionContext) {
          const oauthCtx = context as OAuthResourceContext<{ ownerEmail?: string }>;
          if (
            !workerEnv.DB ||
            oauthCtx.props?.ownerEmail !== workerEnv.ACCESS_OWNER_EMAIL?.toLowerCase() ||
            oauthCtx.auth.userId !== oauthUserId(workerEnv) ||
            oauthCtx.auth.audience !== workerEnv.OAUTH_RESOURCE ||
            (oauthCtx.auth.expiresAt !== undefined && oauthCtx.auth.expiresAt <= Date.now() / 1000)
          )
            return failure("認証が必要です", 403);
          if (!oauthCtx.auth.scope.includes("tasks:read"))
            return insufficientScope(oauthCtx.auth, ["tasks:read"]);
          const token = await workerEnv.OAUTH_PROVIDER?.unwrapToken(oauthCtx.auth.token);
          if (!token?.grantId || token.userId !== oauthCtx.auth.userId)
            return failure("認証が必要です", 403);
          return handleMcp(req, new Set(oauthCtx.auth.scope), async (internal, path) => {
            try {
              return await api(internal, workerEnv, "agent", path, token.grantId);
            } catch {
              console.error(JSON.stringify({ error: "mcp_api_failure" }));
              return failure("処理に失敗しました", 500);
            }
          });
        },
      },
      defaultHandler: {
        async fetch(req: Request, workerEnv: Env) {
          const path = new URL(req.url).pathname;
          if (path === "/authorize") return authorize(req, workerEnv);
          if (path === "/api/connections" || path.startsWith("/api/connections/"))
            return connections(req, workerEnv);
          return boardHandler.fetch(req, workerEnv);
        },
      },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      resourceMetadata: { resource: env.OAUTH_RESOURCE, authorization_servers: [url.origin] },
      scopesSupported: ["tasks:read", "tasks:write", "offline_access"],
      requiredScopes: ["tasks:read"],
      accessTokenTTL: 900,
      refreshTokenTTL: 2592000,
      refreshTokenIdleTTL: 2592000,
      // Legacy callbacks may be stored as registration metadata, never used for codes.
      allowPrivateUseRedirectUris: false,
      clientRegistrationCallback: ({ clientMetadata }) => {
        const redirects = clientMetadata.redirect_uris;
        if (isAllowedClientRegistration(redirects, env)) return undefined;
        console.warn(
          "OAuth client registration redirect rejected",
          rejectedRedirectSummary(redirects),
        );
        return {
          code: "invalid_client_metadata",
          description: "Redirect URI is not allowed",
          status: 400,
        };
      },
    });
    try {
      return await provider.fetch(request, env, ctx);
    } catch {
      console.error(JSON.stringify({ error: "request_failure" }));
      return failure("処理に失敗しました", 500);
    }
  },
  scheduled: boardHandler.scheduled,
} satisfies ExportedHandler<Env>;
