import type { RoutingResult, RoutingSettings } from "../worker/routing";
import type { ConnectionState } from "../worker/connections";
import { t, type Locale } from "./i18n";

export function TaskExecutionBadge({
  task,
  settings,
  locale,
  connections,
}: {
  task: {
    mcp_connection_id?: string | null;
    agent_preference: string;
    model_preference: string;
    routing?: RoutingResult;
  };
  settings: RoutingSettings;
  locale: Locale;
  connections: ConnectionState;
}) {
  const modelId =
    task.routing?.candidate_model_id ||
    (task.model_preference !== "auto" ? task.model_preference : null);
  if (!modelId) return null;
  const model = settings.models.find((item) => item.id === modelId);
  const connectionId = task.mcp_connection_id ?? connections.default_connection_id;
  const connection = connections.connections.find((item) => item.id === connectionId);
  const agentName =
    connection?.client_name ||
    t(locale, connectionId ? "connectionDisconnected" : "noAssignedConnection");
  const modelName = model?.label || modelId;
  return (
    <div
      className="task-execution"
      title={`${t(locale, "configuredAssignment")} · ${t(locale, "agent")}: ${agentName} · ${t(locale, "model")}: ${modelName}`}
    >
      <span className="execution-model">{modelName}</span>
    </div>
  );
}
