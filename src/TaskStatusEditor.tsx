import { useEffect, useRef, useState } from "react";
import { t, type Locale } from "./i18n";

type Status = "backlog" | "todo" | "in_progress" | "review" | "done" | "stopped";

export function TaskStatusEditor({
  value,
  options,
  disabled,
  onSave,
  locale,
}: {
  value: Status;
  options: Status[];
  disabled: boolean;
  onSave: (status: Status) => Promise<void>;
  locale: Locale;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const changed = draft !== value;
  const save = async () => {
    if (pending.current || disabled || !changed) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="task-status-editor" aria-busy={saving}>
      <label>
        {t(locale, "status")}
        <select
          value={draft}
          disabled={disabled || saving || options.length < 2}
          onChange={(event) => {
            setDraft(event.target.value as Status);
            setError("");
          }}
        >
          {options.map((status) => (
            <option key={status} value={status}>
              {t(locale, status)}
            </option>
          ))}
        </select>
      </label>
      {changed && (
        <div className="task-status-actions">
          <button
            className="secondary"
            disabled={disabled || saving}
            onClick={() => {
              setDraft(value);
              setError("");
            }}
          >
            {t(locale, "cancel")}
          </button>
          <button className="primary" disabled={disabled || saving} onClick={() => void save()}>
            {t(locale, saving ? "saving" : "save")}
          </button>
        </div>
      )}
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
