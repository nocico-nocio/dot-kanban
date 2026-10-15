import type { ApiCall } from "./api-client";
import { useId, useState } from "react";
import { serviceSchema, type Service } from "../worker/routing";
import { ServiceIcon } from "./ServiceIcon";
import { IconPickerModal } from "./IconPickerModal";
import { t, type Locale } from "./i18n";

type Props = {
  locale: Locale;
  call: ApiCall;
  services: Service[];
  onCreate: (service: Service) => Promise<void>;
  onCancel: () => void;
};

export function ProjectRegistration({ locale, call, services, onCreate, onCancel }: Props) {
  const id = useId();
  const [draft, setDraft] = useState<Service>(() => ({
    id: `s-${crypto.randomUUID()}`,
    name: "",
    repository: "",
    icon: "symbol:folder",
  }));
  const [pickingIcon, setPickingIcon] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const register = async () => {
    if (saving) return;
    const parsed = serviceSchema.safeParse(draft);
    if (!parsed.success) {
      setError(t(locale, "service_settings_invalid"));
      return;
    }
    if (
      services.length >= 100 ||
      services.some(
        (service) => service.name.trim().toLowerCase() === parsed.data.name.toLowerCase(),
      )
    ) {
      setError(t(locale, "project_duplicate_or_limit"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onCreate(parsed.data);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      className="project-registration"
      aria-labelledby={`${id}-heading`}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type !== "file") {
          e.preventDefault();
          void register();
        }
      }}
    >
      <div className="project-registration-head">
        <button
          type="button"
          className="project-icon-trigger"
          aria-label={t(locale, "chooseIcon")}
          aria-haspopup="dialog"
          disabled={saving}
          onClick={() => setPickingIcon(true)}
        >
          <ServiceIcon name={draft.name} icon={draft.icon} />
        </button>
        <div>
          <h3 id={`${id}-heading`}>{t(locale, "addProject")}</h3>
          <p>{draft.name || t(locale, "projectRegistrationHint")}</p>
        </div>
      </div>
      <label className="setting-field">
        <span>{t(locale, "projectName")} *</span>
        <input
          autoFocus
          disabled={saving}
          maxLength={120}
          value={draft.name}
          placeholder={t(locale, "projectName")}
          onChange={(e) => {
            setError("");
            setDraft({ ...draft, name: e.target.value });
          }}
        />
      </label>
      <label className="setting-field">
        <span>{t(locale, "optionalRepository")}</span>
        <input
          type="url"
          disabled={saving}
          maxLength={2000}
          value={draft.repository}
          placeholder="https://…"
          onChange={(e) => {
            setError("");
            setDraft({ ...draft, repository: e.target.value });
          }}
        />
      </label>
      {pickingIcon && (
        <IconPickerModal
          name={draft.name}
          value={draft.icon}
          locale={locale}
          call={call}
          onApply={(icon) => {
            setError("");
            setDraft((current) => ({ ...current, icon }));
            setPickingIcon(false);
          }}
          onClose={() => setPickingIcon(false)}
        />
      )}
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
      <div className="project-registration-actions">
        <button type="button" disabled={saving} onClick={onCancel}>
          {t(locale, "cancel")}
        </button>
        <button type="button" className="primary" disabled={saving} onClick={() => void register()}>
          {t(locale, saving ? "saving" : "registerProject")}
        </button>
      </div>
    </section>
  );
}
