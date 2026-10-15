import { settingsSchema, resolveRouting } from "../worker/routing.ts";
import { adapterRequest, createMockAdapter } from "../worker/adapter.ts";
import { detectLocale, initialLocale, locales, messages, t } from "../src/i18n.ts";

const settings = {
  targets: [
    { id: "laptop", label: "Laptop", kind: "device", enabled: true },
    { id: "cloud-one", label: "Cloud", kind: "cloud", enabled: true },
  ],
  agents: [
    {
      id: "codex",
      label: "Codex",
      adapter: "codex_cli",
      target_kinds: ["device", "cloud"],
      enabled: true,
    },
    {
      id: "claude",
      label: "Claude",
      adapter: "claude_code",
      target_kinds: ["device"],
      enabled: false,
    },
  ],
  models: [
    {
      id: "model-a",
      label: "A",
      agent_id: "codex",
      target_kinds: ["device", "cloud"],
      enabled: true,
    },
    { id: "model-b", label: "B", agent_id: "claude", target_kinds: ["device"], enabled: false },
  ],
  rules: [
    {
      id: "urgent-code",
      rank: 1,
      enabled: true,
      task_type: "coding",
      priority: "urgent",
      project: "",
      agent_id: "codex",
      model_id: "model-a",
      target_id: "cloud-one",
    },
    {
      id: "all",
      rank: 2,
      enabled: true,
      task_type: "any",
      priority: "any",
      project: "",
      agent_id: "codex",
      model_id: "model-a",
      target_id: "laptop",
    },
  ],
};
const input = {
  task_type: "coding",
  priority: "urgent",
  project: "",
  agent_preference: "auto",
  model_preference: "auto",
  target_preference: "auto",
};
const checks = [];
checks.push(["settings valid", settingsSchema.safeParse(settings).success]);
checks.push([
  "rank conflict",
  !settingsSchema.safeParse({
    ...settings,
    rules: settings.rules.map((rule) => ({ ...rule, rank: 1 })),
  }).success,
]);
const automatic = resolveRouting(settings, input);
checks.push([
  "priority rule",
  automatic.chosen_rule_id === "urgent-code" &&
    automatic.matched_rule_ids.join(",") === "urgent-code,all" &&
    automatic.candidate_target_id === "cloud-one",
]);
checks.push([
  "manual target wins",
  resolveRouting(settings, { ...input, target_preference: "laptop" }).candidate_target_id ===
    "laptop",
]);
checks.push([
  "manual agent wins",
  resolveRouting(settings, { ...input, agent_preference: "claude" }).candidate_agent_id ===
    "claude",
]);
checks.push([
  "manual model wins",
  resolveRouting(settings, { ...input, model_preference: "model-b" }).candidate_model_id ===
    "model-b",
]);
checks.push([
  "disabled agent and model",
  resolveRouting(settings, {
    ...input,
    agent_preference: "claude",
    model_preference: "model-b",
    target_preference: "laptop",
  }).blocked_reasons.includes("agent_disabled") &&
    resolveRouting(settings, {
      ...input,
      agent_preference: "claude",
      model_preference: "model-b",
      target_preference: "laptop",
    }).blocked_reasons.includes("model_disabled"),
]);
checks.push([
  "unregistered model no fallback",
  resolveRouting(settings, { ...input, model_preference: "missing" }).blocked_reasons.includes(
    "model_unregistered",
  ) &&
    resolveRouting(settings, { ...input, model_preference: "missing" }).candidate_model_id ===
      "missing",
]);
checks.push([
  "offline target no fallback",
  resolveRouting(settings, input, { "cloud-one": "offline" }).blocked_reasons.includes(
    "target_offline",
  ) &&
    resolveRouting(settings, input, { "cloud-one": "offline" }).candidate_target_id === "cloud-one",
]);
checks.push([
  "incompatible model target",
  resolveRouting(settings, { ...input, model_preference: "model-b" }).blocked_reasons.includes(
    "model_target_mismatch",
  ),
]);
checks.push([
  "cloud is not Cloudflare dispatch",
  automatic.execution_plan?.adapter === "cloud_unconfigured" && automatic.can_dispatch === false,
]);
const mock = createMockAdapter();
checks.push([
  "adapter remains closed",
  adapterRequest(
    "11111111-1111-1111-1111-111111111111",
    resolveRouting(settings, { ...input, target_preference: "laptop" }, { laptop: "online" }),
  ) === null && mock.calls.length === 0,
]);
checks.push([
  "mock records typed request only",
  mock.submit({
    adapter: "codex_cli",
    target_kind: "device",
    model_id: "model-a",
    task_id: "11111111-1111-1111-1111-111111111111",
  }).accepted && mock.calls.length === 1,
]);
checks.push([
  "legacy auto preferences",
  resolveRouting({ targets: [], agents: [], models: [], rules: [] }, input).rationale_code ===
    "no_rule",
]);
checks.push([
  "locale regions",
  detectLocale("zh-Hant-HK") === "zh-TW" &&
    detectLocale("zh-TW") === "zh-TW" &&
    detectLocale("zh-Hans-SG") === "zh-CN" &&
    detectLocale("zh-CN") === "zh-CN" &&
    detectLocale("fr-FR") === "en",
]);
checks.push([
  "saved locale",
  initialLocale({ getItem: () => "ko" }, "en-US") === "ko" &&
    initialLocale({ getItem: () => "invalid" }, "ja-JP") === "ja",
]);
checks.push([
  "complete translations",
  Object.values(messages).every(
    (value) =>
      value.length === locales.length &&
      value.every((item) => typeof item === "string" && item.trim().length > 0),
  ),
]);
checks.push([
  "long translations",
  locales.every((locale) => t(locale, "approvalCheck").length > 15),
]);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
