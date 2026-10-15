import { z } from "zod";

const key = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const label = z.string().trim().min(1).max(80);
const taskType = z.enum(["general", "coding", "research", "writing"]);
const priority = z.enum(["low", "medium", "high", "urgent"]);
const targetKind = z.enum(["device", "cloud"]);
const preference = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !/[\u0000-\u0020\u007f]/.test(value)
      );
    } catch {
      return false;
    }
  });
export const projectIcons = [
  "symbol:folder",
  "symbol:code",
  "symbol:globe",
  "symbol:rocket",
  "symbol:terminal",
  "symbol:book",
  "symbol:palette",
  "symbol:database",
  "symbol:bolt",
  "symbol:heart",
  "symbol:apple",
  "symbol:windows",
  "symbol:calendar",
] as const;
export const serviceSchema = z
  .object({
    id: key,
    name: z.string().trim().min(1).max(120),
    repository: httpsUrl,
    icon: z.union([
      httpsUrl,
      z.enum(projectIcons),
      z.string().regex(/^\/api\/service-icons\/[0-9a-f-]{36}$/),
    ]),
  })
  .strict();
export type Service = z.infer<typeof serviceSchema>;
export const targetSchema = z
  .object({ id: key, label, kind: targetKind, enabled: z.boolean() })
  .strict();
export const agentSchema = z
  .object({
    id: key,
    label,
    enabled: z.boolean(),
    adapter: z.enum(["codex_cli", "claude_code"]),
    target_kinds: z.array(targetKind).min(1).max(2),
  })
  .strict();
export const modelSchema = z
  .object({
    id: key,
    agent_id: key,
    label,
    enabled: z.boolean(),
    target_kinds: z.array(targetKind).min(1).max(2),
  })
  .strict();
export const ruleSchema = z
  .object({
    id: key,
    rank: z.number().int().min(1).max(9999),
    enabled: z.boolean(),
    task_type: z.union([taskType, z.literal("any")]),
    priority: z.union([priority, z.literal("any")]),
    project: z.string().max(120),
    agent_id: key,
    model_id: key,
    target_id: key,
  })
  .strict();
export const settingsSchema = z
  .object({
    services: z.array(serviceSchema).max(100).default([]),
    targets: z.array(targetSchema).max(30),
    agents: z.array(agentSchema).max(20),
    models: z.array(modelSchema).max(100),
    rules: z.array(ruleSchema).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.services.map((service) => service.name.toLowerCase())).size !==
      value.services.length
    )
      ctx.addIssue({ code: "custom", message: "service_duplicate_name" });
    for (const [name, values] of [
      ["services", value.services],
      ["targets", value.targets],
      ["agents", value.agents],
      ["models", value.models],
      ["rules", value.rules],
    ] as const) {
      const ids = values.map((item) => item.id);
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: "custom", message: `${name}_duplicate_id` });
    }
    if (value.targets.some((item) => ["auto", "cloud", "device"].includes(item.id)))
      ctx.addIssue({ code: "custom", message: "target_reserved_id" });
    if (new Set(value.rules.map((item) => item.rank)).size !== value.rules.length)
      ctx.addIssue({ code: "custom", message: "rule_rank_conflict" });
    for (const model of value.models)
      if (!value.agents.some((agent) => agent.id === model.agent_id))
        ctx.addIssue({ code: "custom", message: "model_agent_missing" });
    for (const rule of value.rules) {
      const model = value.models.find((item) => item.id === rule.model_id);
      if (
        !value.agents.some((agent) => agent.id === rule.agent_id) ||
        !model ||
        model.agent_id !== rule.agent_id ||
        !value.targets.some((target) => target.id === rule.target_id)
      )
        ctx.addIssue({ code: "custom", message: "rule_reference_invalid" });
    }
  });
export const preferencesSchema = z
  .object({
    task_type: taskType,
    agent_preference: preference,
    model_preference: preference,
    target_preference: preference,
  })
  .strict();
export type RoutingSettings = z.infer<typeof settingsSchema>;
export type RoutingInput = z.infer<typeof preferencesSchema> & {
  priority: z.infer<typeof priority>;
  project: string;
};
export type RoutingResult = {
  candidate_agent_id: string | null;
  candidate_model_id: string | null;
  candidate_target_id: string | null;
  source: "manual" | "rule" | "none";
  matched_rule_ids: string[];
  chosen_rule_id: string | null;
  blocked_reasons: string[];
  rationale_code: string;
  execution_plan: {
    target_kind: "device" | "cloud";
    adapter: "codex_cli" | "claude_code" | "cloud_unconfigured";
    arguments: { model_id: string };
  } | null;
  can_dispatch: false;
};
export type ObservedStates = Record<string, "online" | "offline" | "unverified">;

export function resolveRouting(
  settings: RoutingSettings,
  input: RoutingInput,
  observed: ObservedStates = {},
): RoutingResult {
  const matched = settings.rules
    .filter(
      (rule) =>
        rule.enabled &&
        (rule.task_type === "any" || rule.task_type === input.task_type) &&
        (rule.priority === "any" || rule.priority === input.priority) &&
        (!rule.project || rule.project === input.project),
    )
    .sort((a, b) => a.rank - b.rank);
  const rule = matched[0];
  const manualAgent = input.agent_preference !== "auto",
    manualModel = input.model_preference !== "auto",
    manualTarget = input.target_preference !== "auto";
  const requestedModel = manualModel
    ? settings.models.find((item) => item.id === input.model_preference)
    : undefined;
  const agentId = manualAgent
    ? input.agent_preference
    : (requestedModel?.agent_id ?? rule?.agent_id ?? null);
  const targetKindChoice = ["cloud", "device"].includes(input.target_preference)
    ? input.target_preference
    : null;
  const chosenTarget = manualTarget
    ? targetKindChoice
      ? settings.targets
          .filter((item) => item.kind === targetKindChoice && item.enabled)
          .sort((a, b) => a.id.localeCompare(b.id))[0]
      : settings.targets.find((item) => item.id === input.target_preference)
    : settings.targets.find((item) => item.id === rule?.target_id);
  const targetId =
    chosenTarget?.id ?? (manualTarget && !targetKindChoice ? input.target_preference : null);
  const modelId = manualModel
    ? input.model_preference
    : rule?.agent_id === agentId
      ? rule.model_id
      : (settings.models
          .filter(
            (item) =>
              item.agent_id === agentId &&
              item.enabled &&
              (!chosenTarget || item.target_kinds.includes(chosenTarget.kind)),
          )
          .sort((a, b) => a.id.localeCompare(b.id))[0]?.id ?? null);
  const agent = settings.agents.find((item) => item.id === agentId),
    model = settings.models.find((item) => item.id === modelId);
  const blocked: string[] = [];
  if (manualAgent && !agent) blocked.push("agent_unregistered");
  if (manualModel && !model) blocked.push("model_unregistered");
  if (manualTarget && !chosenTarget) blocked.push("target_unregistered");
  if (agent && !agent.enabled) blocked.push("agent_disabled");
  if (model && !model.enabled) blocked.push("model_disabled");
  if (chosenTarget && !chosenTarget.enabled) blocked.push("target_disabled");
  if (agent && model && model.agent_id !== agent.id) blocked.push("model_agent_mismatch");
  if (agent && !model) blocked.push("model_unavailable");
  if (agent && chosenTarget && !agent.target_kinds.includes(chosenTarget.kind))
    blocked.push("agent_target_mismatch");
  if (model && chosenTarget && !model.target_kinds.includes(chosenTarget.kind))
    blocked.push("model_target_mismatch");
  if (chosenTarget && observed[chosenTarget.id] === "offline") blocked.push("target_offline");
  else if (chosenTarget && observed[chosenTarget.id] !== "online")
    blocked.push("target_unverified");
  if (agent) blocked.push("agent_unconnected");
  const source = manualAgent || manualModel || manualTarget ? "manual" : rule ? "rule" : "none";
  const executionPlan =
    chosenTarget && model && agent && model.agent_id === agent.id
      ? {
          target_kind: chosenTarget.kind,
          adapter: chosenTarget.kind === "device" ? agent.adapter : ("cloud_unconfigured" as const),
          arguments: { model_id: model.id },
        }
      : null;
  return {
    candidate_agent_id: agentId,
    candidate_model_id: modelId,
    candidate_target_id: targetId,
    source,
    matched_rule_ids: matched.map((item) => item.id),
    chosen_rule_id: rule?.id ?? null,
    blocked_reasons: blocked,
    rationale_code: source === "manual" ? "manual_precedence" : rule ? "rule_match" : "no_rule",
    execution_plan: executionPlan,
    can_dispatch: false,
  };
}

export function publicSettings(settings: RoutingSettings, observed: ObservedStates = {}) {
  return {
    ...settings,
    targets: settings.targets.map((target) => ({
      ...target,
      connection_state: observed[target.id] ?? "unverified",
    })),
    agents: settings.agents.map((agent) => ({ ...agent, connection_state: "unconnected" })),
  };
}

export const editableSettings = (config: RoutingSettings): RoutingSettings => ({
  services: config.services.map(({ id, name, repository, icon }) => ({
    id,
    name,
    repository,
    icon,
  })),
  targets: config.targets.map(({ id, label, kind, enabled }) => ({ id, label, kind, enabled })),
  agents: config.agents.map(({ id, label, adapter, target_kinds, enabled }) => ({
    id,
    label,
    adapter,
    target_kinds,
    enabled,
  })),
  models: config.models.map(({ id, label, agent_id, target_kinds, enabled }) => ({
    id,
    label,
    agent_id,
    target_kinds,
    enabled,
  })),
  rules: config.rules.map(
    ({ id, rank, enabled, task_type, priority, project, agent_id, model_id, target_id }) => ({
      id,
      rank,
      enabled,
      task_type,
      priority,
      project,
      agent_id,
      model_id,
      target_id,
    }),
  ),
});
