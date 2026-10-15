import type { ConnectionState } from "../worker/connections";
import { canExecute } from "../worker/connections";
import { AgentIcon } from "./AgentIcon";
import { OverflowMenu } from "./OverflowMenu";
import { t, type Locale } from "./i18n";

export function ConnectionPicker({
  value,
  state,
  locale,
  onChange,
  disabled = false,
  iconOnly = false,
}: {
  value: string | null;
  state: ConnectionState;
  locale: Locale;
  onChange?: (id: string) => void;
  disabled?: boolean;
  iconOnly?: boolean;
}) {
  const id = value ?? state.default_connection_id;
  const selected = state.connections.find((item) => item.id === id);
  const name =
    selected?.client_name || t(locale, id ? "connectionDisconnected" : "noAssignedConnection");
  if (iconOnly) {
    const canChoose =
      onChange &&
      (state.connections.length > 1 || (id && !selected && state.default_connection_id));
    return (
      <div className="agent-picker">
        {canChoose ? (
          <OverflowMenu
            label={t(locale, "taskAgent")}
            title={name}
            disabled={disabled}
            triggerClassName="agent-picker-trigger"
            triggerContent={<AgentIcon connection={selected} name={name} />}
          >
            {state.connections.map((item) => (
              <button
                type="button"
                className="agent-choice"
                key={item.id}
                role="menuitemradio"
                aria-label={item.client_name}
                aria-checked={item.id === id}
                disabled={disabled || !canExecute(item)}
                onClick={() => onChange(item.id)}
              >
                <AgentIcon connection={item} />
                <span className="agent-choice-name">
                  {item.client_name}
                  {item.id === state.default_connection_id && (
                    <small>{t(locale, "defaultConnection")}</small>
                  )}
                  {!canExecute(item) && <small>{t(locale, "readOnlyConnection")}</small>}
                </span>
                {item.id === id && <span aria-hidden="true">✓</span>}
              </button>
            ))}
          </OverflowMenu>
        ) : (
          <span className="agent-picker-static" title={name}>
            <AgentIcon connection={selected} name={name} />
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="connection-picker">
      <AgentIcon connection={selected} name={name} />
      {state.connections.length > 1 && onChange ? (
        <select
          aria-label={t(locale, "taskAgent")}
          value={id || ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {!selected && (
            <option value={id || ""} disabled>
              {name}
            </option>
          )}
          {state.connections.map((item) => (
            <option key={item.id} value={item.id} disabled={!canExecute(item)}>
              {item.client_name}
              {item.id === state.default_connection_id
                ? ` · ${t(locale, "defaultConnection")}`
                : ""}
              {!canExecute(item) ? ` · ${t(locale, "readOnlyConnection")}` : ""}
            </option>
          ))}
        </select>
      ) : (
        <span className="connection-name">{name}</span>
      )}
      {id && !selected && state.default_connection_id && onChange && (
        <button
          className="connection-reset"
          type="button"
          disabled={disabled}
          onClick={() => onChange(state.default_connection_id!)}
        >
          {t(locale, "useDefaultConnection")}
        </button>
      )}
    </div>
  );
}
