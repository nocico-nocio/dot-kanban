import type { ApiCall } from "./api-client";
import { useEffect, useId, useRef, useState } from "react";
import { projectIcons } from "../worker/routing";
import { t, type Locale, type MessageKey } from "./i18n";
import { prepareProjectIcon } from "./project-image";

const paths: Record<(typeof projectIcons)[number], string> = {
  "symbol:apple":
    "M11.182.008C11.148-.03 9.923.023 8.857 1.18c-1.066 1.156-.902 2.482-.878 2.516s1.52.087 2.475-1.258.762-2.391.728-2.43m3.314 11.733c-.048-.096-2.325-1.234-2.113-3.422s1.675-2.789 1.698-2.854-.597-.79-1.254-1.157a3.7 3.7 0 0 0-1.563-.434c-.108-.003-.483-.095-1.254.116-.508.139-1.653.589-1.968.607-.316.018-1.256-.522-2.267-.665-.647-.125-1.333.131-1.824.328-.49.196-1.422.754-2.074 2.237-.652 1.482-.311 3.83-.067 4.56s.625 1.924 1.273 2.796c.576.984 1.34 1.667 1.659 1.899s1.219.386 1.843.067c.502-.308 1.408-.485 1.766-.472.357.013 1.061.154 1.782.539.571.197 1.111.115 1.652-.105.541-.221 1.324-1.059 2.238-2.758q.52-1.185.473-1.282",
  "symbol:windows": "M2 2h9v9H2ZM13 2h9v9h-9ZM2 13h9v9H2ZM13 13h9v9h-9Z",
  "symbol:calendar":
    "M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 10h2m4 0h2m-8 4h2m4 0h2",
  "symbol:folder": "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z",
  "symbol:code": "m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16",
  "symbol:globe": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
  "symbol:rocket":
    "M9 15c0-7 6-12 12-12 0 6-5 12-12 12Zm0 0-4-4-2 6 6-2Zm0 0 4 4 6-2-4-4M5 19l-2 2M15 8h1",
  "symbol:terminal": "M3 5h18v14H3Zm4 4 3 3-3 3m6 0h4",
  "symbol:book": "M12 5v15M3 4c4-1 6 0 9 1 3-1 5-2 9-1v15c-4-1-6 0-9 1-3-1-5-2-9-1Z",
  "symbol:palette":
    "M12 3a9 9 0 1 0 0 18c2 0 3-1 2-3s0-3 2-3h2c5 0 3-12-6-12ZM7 10h.01M10 7h.01M15 7h.01M18 10h.01",
  "symbol:database": "M4 6c0-4 16-4 16 0s-16 4-16 0Zm0 0v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0",
  "symbol:bolt": "m13 2-9 12h7l-1 8 10-13h-8Z",
  "symbol:heart": "M12 20 4 12C-2 5 7-1 12 6c5-7 14-1 8 6Z",
};

export function ServiceIcon({ name, icon }: { name: string; icon: string }) {
  const [failed, setFailed] = useState("");
  const solid = icon === "symbol:apple" || icon === "symbol:windows";
  const path = Object.hasOwn(paths, icon) ? paths[icon as keyof typeof paths] : null;
  return (
    <span className={`service-icon${path ? ` icon-${icon.slice(7)}` : ""}`} aria-hidden="true">
      {path ? (
        <svg
          viewBox={icon === "symbol:apple" ? "0 0 16 16" : "0 0 24 24"}
          fill={solid ? "currentColor" : "none"}
          stroke={solid ? "none" : "currentColor"}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={path} />
        </svg>
      ) : (icon.startsWith("https://") || /^\/api\/service-icons\/[0-9a-f-]{36}$/.test(icon)) &&
        failed !== icon ? (
        <img src={icon} alt="" referrerPolicy="no-referrer" onError={() => setFailed(icon)} />
      ) : (
        <span>{Array.from(name.trim())[0]?.toUpperCase() || "◇"}</span>
      )}
    </span>
  );
}

export function IconPicker({
  value,
  onChange,
  locale,
  call,
  disabled = false,
  onBusyChange,
}: {
  value: string;
  onChange: (value: string) => void;
  locale: Locale;
  call: ApiCall;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const request = useRef<AbortController | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => request.current?.abort(), []);
  const upload = async (file: File) => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setUploading(true);
    onBusyChange?.(true);
    setError("");
    try {
      const body = await prepareProjectIcon(file);
      if (controller.signal.aborted) return;
      const result = await call<{ icon: string }>("/api/service-icons", {
        method: "POST",
        headers: { "content-type": "image/png" },
        body,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) onChange(result.icon);
    } catch {
      if (!controller.signal.aborted) setError(t(locale, "icon_upload_invalid"));
    } finally {
      if (!controller.signal.aborted) {
        setUploading(false);
        onBusyChange?.(false);
      }
    }
  };
  return (
    <div className="project-icon-picker">
      <span className="project-field-title">{t(locale, "chooseIcon")}</span>
      <div className="project-icon-options" role="group" aria-label={t(locale, "chooseIcon")}>
        {projectIcons.map((icon) => (
          <button
            type="button"
            key={icon}
            disabled={disabled || uploading}
            aria-label={t(locale, `icon_${icon.slice(7)}` as MessageKey)}
            aria-pressed={value === icon}
            onClick={() => {
              setError("");
              onChange(icon);
            }}
          >
            <ServiceIcon name="" icon={icon} />
          </button>
        ))}
      </div>
      <div className="project-upload">
        <label htmlFor={id}>{t(locale, uploading ? "iconUploading" : "uploadIcon")}</label>
        <input
          id={id}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
          disabled={disabled || uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
      <p className="project-help">{t(locale, "iconUploadHint")}</p>
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
