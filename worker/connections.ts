import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type McpConnection = {
  id: string;
  client_id: string;
  client_name: string;
  scopes: string[];
  created_at: number;
  expires_at?: number;
};
export type ConnectionState = {
  connections: McpConnection[];
  default_connection_id: string | null;
  version: number;
};
export const canExecute = (item: McpConnection) =>
  item.scopes.includes("tasks:read") && item.scopes.includes("tasks:write");
export const validConnectionId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export async function connectionState(env: {
  DB: D1Database;
  OAUTH_PROVIDER?: OAuthHelpers;
  ACCESS_OWNER_EMAIL?: string;
  OAUTH_RESOURCE?: string;
}): Promise<ConnectionState> {
  const connections: McpConnection[] = [];
  if (env.OAUTH_PROVIDER) {
    let cursor: string | undefined;
    do {
      const result = await env.OAUTH_PROVIDER.listUserGrants(
        encodeURIComponent((env.ACCESS_OWNER_EMAIL || "").toLowerCase()),
        { cursor },
      );
      for (const grant of result.items) {
        if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now() / 1000) continue;
        if (
          grant.resource &&
          !(Array.isArray(grant.resource) ? grant.resource : [grant.resource]).includes(
            env.OAUTH_RESOURCE || "",
          )
        )
          continue;
        connections.push({
          id: grant.id,
          client_id: grant.clientId,
          client_name:
            typeof grant.metadata?.clientName === "string"
              ? grant.metadata.clientName
              : grant.clientId,
          scopes: grant.scope,
          created_at: grant.createdAt,
          expires_at: grant.expiresAt,
        });
      }
      cursor = result.cursor;
    } while (cursor);
  }
  connections.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const executable = connections.filter(canExecute);
  let preferences = await env.DB.prepare(
    "SELECT default_connection_id,version FROM mcp_preferences WHERE id=1",
  ).first<{ default_connection_id: string | null; version: number }>();
  const fallback = executable[0]?.id ?? null;
  if (
    preferences &&
    !executable.some((item) => item.id === preferences!.default_connection_id) &&
    preferences.default_connection_id !== fallback
  ) {
    await env.DB.prepare(
      "UPDATE mcp_preferences SET default_connection_id=?,version=version+1 WHERE id=1 AND version=?",
    )
      .bind(fallback, preferences.version)
      .run();
    preferences = await env.DB.prepare(
      "SELECT default_connection_id,version FROM mcp_preferences WHERE id=1",
    ).first<{ default_connection_id: string | null; version: number }>();
  }
  return {
    connections,
    default_connection_id:
      executable.find((item) => item.id === preferences?.default_connection_id)?.id ?? fallback,
    version: preferences?.version ?? 1,
  };
}
