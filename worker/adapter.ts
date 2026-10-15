import type { RoutingResult } from "./routing";

// An executor may consume only this structured shape. Task text never becomes a command.
export type AdapterRequest = {
  adapter: "codex_cli" | "claude_code";
  target_kind: "device";
  model_id: string;
  task_id: string;
};
export function adapterRequest(taskId: string, route: RoutingResult): AdapterRequest | null {
  const plan = route.execution_plan;
  if (
    !/^[a-f0-9-]{36}$/.test(taskId) ||
    !plan ||
    route.blocked_reasons.length ||
    !route.can_dispatch ||
    plan.target_kind !== "device" ||
    !["codex_cli", "claude_code"].includes(plan.adapter)
  )
    return null;
  return {
    adapter: plan.adapter as AdapterRequest["adapter"],
    target_kind: "device",
    model_id: plan.arguments.model_id,
    task_id: taskId,
  };
}

// Test-only recorder: does not launch a process, contact a provider, or publish an event.
export function createMockAdapter() {
  const calls: AdapterRequest[] = [];
  return {
    calls,
    submit(request: AdapterRequest) {
      calls.push(structuredClone(request));
      return { accepted: true as const, attempt: calls.length };
    },
  };
}
