import type { ApiCall } from "./api-client";
import { useEffect, useRef, useState } from "react";
import type { RoutingSettings, Service } from "../worker/routing";
import { editableSettings, settingsSchema } from "../worker/routing";
import { t, type Locale } from "./i18n";
import { ServiceSettings } from "./ServiceSettings";

type ResponseData = { version: number; config: RoutingSettings };

export function ProjectsScreen({ locale, call }: { locale: Locale; call: ApiCall }) {
  const [data, setData] = useState<ResponseData | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [saved, setSaved] = useState<string | null>(null);
  const load = async () => {
    try {
      setData(await call<ResponseData>("/api/settings"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Registration, deletion and order changes persist immediately, without saving unrelated drafts.
  const mutateServices = async (update: (services: Service[]) => Service[]) => {
    if (!data || pending.current) throw new Error(t(locale, "savingSettings"));
    pending.current = true;
    setSaving(true);
    setSaved(null);
    try {
      const latest = await call<ResponseData>("/api/settings");
      if (latest.version !== data.version) throw new Error(t(locale, "settings_conflict"));
      const config = editableSettings(latest.config);
      config.services = update(config.services);
      const result = await call<ResponseData>("/api/settings", {
        method: "PUT",
        headers: { "if-match": String(latest.version) },
        body: JSON.stringify(config),
      });
      setData((current) =>
        current
          ? {
              ...current,
              version: result.version,
              config: { ...current.config, services: update(current.config.services) },
            }
          : current,
      );
      setError("");
      setSaved(JSON.stringify(editableSettings(result.config)));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const removeService = async (id: string) => {
    try {
      await mutateServices((services) => services.filter((service) => service.id !== id));
    } catch (error) {
      setError((error as Error).message);
    }
  };
  const moveService = async (id: string, beforeId: string | null) => {
    if (id === beforeId) return;
    try {
      await mutateServices((services) => {
        const service = services.find((item) => item.id === id);
        if (!service) return services;
        const reordered = services.filter((item) => item.id !== id);
        const index = beforeId
          ? reordered.findIndex((item) => item.id === beforeId)
          : reordered.length;
        reordered.splice(index < 0 ? reordered.length : index, 0, service);
        return reordered;
      });
    } catch (error) {
      setError((error as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const save = async () => {
    if (!data || pending.current) return;
    const config = editableSettings(data.config);
    const parsed = settingsSchema.safeParse(config);
    if (!parsed.success) {
      setError(
        t(
          locale,
          parsed.error.issues.some(
            (issue) => issue.path[0] === "services" || issue.message.startsWith("service"),
          )
            ? "service_settings_invalid"
            : "settings_invalid",
        ),
      );
      return;
    }
    const submitted = JSON.stringify(config);
    pending.current = true;
    setSaving(true);
    setSaved(null);
    try {
      const result = await call<{ version: number; config: RoutingSettings }>("/api/settings", {
        method: "PUT",
        headers: { "if-match": String(data.version) },
        body: submitted,
      });
      setData((current) =>
        current
          ? {
              ...current,
              version: result.version,
              config:
                JSON.stringify(editableSettings(current.config)) === submitted
                  ? result.config
                  : current.config,
            }
          : current,
      );
      setError("");
      setSaved(JSON.stringify(editableSettings(result.config)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  if (!data) return <p role="status">{error || "…"}</p>;
  return (
    <section className="settings-page">
      <header className="settings-head">
        <h1>{t(locale, "services")}</h1>
        <div className="settings-save">
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {t(locale, saving ? "savingSettings" : "save")}
          </button>
          {saved === JSON.stringify(editableSettings(data.config)) && (
            <span role="status">{t(locale, "settingsSaved")}</span>
          )}
        </div>
      </header>
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      <ServiceSettings
        standalone
        locale={locale}
        call={call}
        services={data.config.services}
        disabled={saving}
        onRemove={removeService}
        onCreate={(service) => mutateServices((services) => [...services, service])}
        onMove={moveService}
        setServices={(update) => {
          setSaved(null);
          setData((current) =>
            current
              ? {
                  ...current,
                  config: { ...current.config, services: update(current.config.services) },
                }
              : current,
          );
        }}
      />
    </section>
  );
}
