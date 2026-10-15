import type { ApiCall } from "./api-client";
import { useEffect, useState } from "react";
import { formatDate, t, type Locale } from "./i18n";
import { McpSetupGuide } from "./McpSetupGuide";
import { AgentIcon } from "./AgentIcon";
import { canExecute, type McpConnection, type ConnectionState } from "../worker/connections";

export function McpConnectionsScreen({ locale, call }: { locale: Locale; call: ApiCall }) {
  const [connectionData, setConnectionData] = useState<ConnectionState>({
    connections: [],
    default_connection_id: null,
    version: 1,
  });
  const [connectionBusy, setConnectionBusy] = useState(false);
  const { connections } = connectionData;
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const endpoint = new URL("/mcp", window.location.origin).href;
  const loadConnections = async () => {
    try {
      setConnectionData(await call<ConnectionState>("/api/connections"));
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const revoke = async (item: McpConnection) => {
    if (!window.confirm(t(locale, "revokeConnectionConfirm"))) return;
    try {
      await call("/api/connections/" + encodeURIComponent(item.id), { method: "DELETE" });
      await loadConnections();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const makeDefault = async (id: string) => {
    setConnectionBusy(true);
    try {
      setConnectionData(
        await call<ConnectionState>("/api/connections/default", {
          method: "PUT",
          headers: { "if-match": String(connectionData.version) },
          body: JSON.stringify({ connection_id: id }),
        }),
      );
      setError("");
    } catch (error) {
      await loadConnections();
      setError((error as Error).message);
    } finally {
      setConnectionBusy(false);
    }
  };
  useEffect(() => {
    void loadConnections();
  }, []);
  return (
    <section className="settings-page connections-page">
      <header className="settings-head">
        <h1>{t(locale, "mcpConnections")}</h1>
      </header>
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      {!loaded && !error && <p role="status">…</p>}
      <section className="setting-group mcp-settings" aria-labelledby="mcp-connected-heading">
        <h2 id="mcp-connected-heading" className="mcp-connected-heading">
          {t(locale, "connectedAgents")}
        </h2>
        {!loaded ? null : connections.length ? (
          <div className="mcp-connections">
            {connections.map((item) => (
              <div className="setting-row" key={item.id}>
                <AgentIcon connection={item} />
                <div className="mcp-connection-info">
                  <strong>{item.client_name || item.client_id}</strong>
                  <p>
                    {item.scopes
                      .map((scope) =>
                        scope === "tasks:read"
                          ? t(locale, "mcpRead")
                          : scope === "tasks:write"
                            ? t(locale, "mcpWrite")
                            : scope === "offline_access"
                              ? t(locale, "mcpKeepConnection")
                              : scope,
                      )
                      .join(" · ")}{" "}
                    · {formatDate(locale, new Date(item.created_at * 1000).toISOString())}
                  </p>
                </div>
                <div className="mcp-connection-actions">
                  {item.id === connectionData.default_connection_id ? (
                    <span className="default-connection-badge">
                      {t(locale, "defaultConnection")}
                    </span>
                  ) : (
                    canExecute(item) && (
                      <button
                        type="button"
                        disabled={connectionBusy}
                        onClick={() => void makeDefault(item.id)}
                      >
                        {t(locale, "makeDefaultConnection")}
                      </button>
                    )
                  )}
                  <button type="button" disabled={connectionBusy} onClick={() => void revoke(item)}>
                    {t(locale, "revokeConnection")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mcp-empty">{t(locale, "noConnections")}</p>
        )}
        <McpSetupGuide locale={locale} endpoint={endpoint} />
      </section>
    </section>
  );
}
