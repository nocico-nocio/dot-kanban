import { useEffect, useRef, useState } from "react";
import { t, type Locale } from "./i18n";

export function InlineText({
  value,
  label,
  multiline = false,
  onSave,
  locale,
}: {
  value: string;
  label: string;
  multiline?: boolean;
  onSave: (value: string) => Promise<void>;
  locale: Locale;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const focused = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const save = async () => {
    const next = multiline ? draft : draft.trim();
    if (next === value || pending.current) return;
    if (!multiline && !next) {
      setDraft(value);
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(next);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <div className={`inline-text ${multiline ? "inline-description" : "inline-title"}`}>
      <textarea
        aria-label={label}
        value={draft}
        placeholder={label}
        rows={multiline ? 5 : 2}
        maxLength={multiline ? 10000 : 160}
        disabled={saving}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          focused.current = false;
          void save();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
          }
          if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
        }}
      />
      {saving && (
        <span className="field-saving" role="status">
          {t(locale, "saving")}
        </span>
      )}
      {error && (
        <p className="project-error" role="alert">
          {error}
          <button className="secondary" onClick={() => void save()}>
            {t(locale, "save")}
          </button>
        </p>
      )}
    </div>
  );
}
