import type { ApiCall } from "./api-client";
import { useEffect, useId, useRef, useState } from "react";
import type { Service } from "../worker/routing";
import { ServiceIcon } from "./ServiceIcon";
import { IconPickerModal } from "./IconPickerModal";
import { t, type Locale } from "./i18n";

export function TaskProjectEditor({
  locale,
  project,
  icon = "symbol:folder",
  services,
  call,
  onSave,
  onServiceIconSave,
  onDraftChange,
  onBusyChange,
  disabled = false,
}: {
  locale: Locale;
  project: string;
  icon?: string;
  services: Service[];
  call: ApiCall;
  onSave?: (project: string, icon: string) => Promise<void>;
  onServiceIconSave?: (service: Service, icon: string) => Promise<void>;
  onDraftChange?: (project: string, icon: string) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(project);
  const [draftIcon, setDraftIcon] = useState(icon);
  const [open, setOpen] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(-1);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const retry = useRef<() => void>(() => {});
  const current = services.find(
    (service) => service.name.toLowerCase() === name.trim().toLowerCase(),
  );
  const displayedIcon = current?.icon || draftIcon;
  const matches = services.filter(
    (service) => !filtering || service.name.toLowerCase().includes(name.trim().toLowerCase()),
  );
  useEffect(() => {
    if (!root.current?.contains(document.activeElement)) setName(project);
  }, [project]);
  useEffect(() => {
    onBusyChange?.(saving || uploading);
  }, [saving, uploading, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const change = (value: string, nextIcon = draftIcon) => {
    setName(value);
    setDraftIcon(nextIcon);
    setError("");
    const match = services.find(
      (service) => service.name.toLowerCase() === value.trim().toLowerCase(),
    );
    if (match) setPickingIcon(false);
    onDraftChange?.(value, match?.icon || nextIcon);
  };
  const commit = async (value = name, nextIcon = displayedIcon, iconChanged = false) => {
    if (disabled || uploading || pending.current) return;
    const match = services.find(
      (service) => service.name.toLowerCase() === value.trim().toLowerCase(),
    );
    const canonical = match?.name || value.trim();
    setOpen(false);
    setPickingIcon(false);
    change(canonical, match?.icon || nextIcon);
    if (!onSave || (canonical === project && !iconChanged)) return;
    pending.current = true;
    setSaving(true);
    try {
      await onSave(canonical, match?.icon || nextIcon);
    } catch (error) {
      setError((error as Error).message);
      retry.current = () => void commit(canonical, nextIcon, iconChanged);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const applyIcon = async (value: string, service = current) => {
    if (disabled || pending.current || uploading) return;
    if (!service || !onServiceIconSave) {
      change(name, value);
      setPickingIcon(false);
      await commit(name, value, true);
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    setPickingIcon(false);
    try {
      await onServiceIconSave(service, value);
      setDraftIcon(value);
      setName(service.name);
      onDraftChange?.(service.name, value);
      if (onSave && service.name !== project) await onSave(service.name, value);
    } catch (error) {
      setError((error as Error).message);
      retry.current = () => void applyIcon(value, service);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const select = (service: Service) => {
    change(service.name, service.icon);
    void commit(service.name, service.icon);
  };
  return (
    <div
      ref={root}
      className="task-project-editor"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setOpen(false);
          if (!pickingIcon) void commit();
        }
      }}
    >
      <div className="project-combobox-control">
        {disabled ? (
          <span className="project-current-icon">
            <ServiceIcon name={name} icon={displayedIcon} />
          </span>
        ) : (
          <button
            type="button"
            className="project-icon-trigger"
            aria-label={t(locale, "chooseIcon")}
            aria-haspopup="dialog"
            aria-expanded={pickingIcon}
            disabled={saving || uploading}
            onClick={() => {
              setOpen(false);
              setPickingIcon(!pickingIcon);
            }}
          >
            <ServiceIcon name={name} icon={displayedIcon} />
          </button>
        )}
        <input
          ref={input}
          role="combobox"
          aria-label={t(locale, "project")}
          aria-autocomplete="list"
          aria-expanded={open && matches.length > 0}
          aria-controls={`${id}-options`}
          aria-activedescendant={
            open && active >= 0 && matches[active] ? `${id}-${active}` : undefined
          }
          value={name}
          placeholder={t(locale, "projectUnset")}
          maxLength={120}
          readOnly={disabled}
          disabled={saving || uploading}
          autoComplete="off"
          onFocus={() => {
            if (!disabled) {
              setOpen(true);
              setFiltering(false);
              setActive(-1);
            }
          }}
          onChange={(event) => {
            change(event.target.value);
            setFiltering(true);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActive((index) =>
                matches.length
                  ? index < 0
                    ? event.key === "ArrowDown"
                      ? 0
                      : matches.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) %
                      matches.length
                  : -1,
              );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (open && active >= 0 && matches[active]) select(matches[active]);
              else void commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              setPickingIcon(false);
              change(project, icon);
            }
          }}
        />
        {saving && (
          <span className="field-saving" role="status">
            {t(locale, "saving")}
          </span>
        )}
      </div>
      {open && matches.length > 0 && (
        <div
          className="project-suggestions"
          id={`${id}-options`}
          role="listbox"
          aria-label={t(locale, "project")}
        >
          {matches.map((service, index) => (
            <button
              type="button"
              id={`${id}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={active === index}
              key={service.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(service)}
            >
              <ServiceIcon name={service.name} icon={service.icon} />
              <span>{service.name}</span>
            </button>
          ))}
        </div>
      )}
      {pickingIcon && !disabled && (
        <IconPickerModal
          name={name}
          value={displayedIcon}
          locale={locale}
          call={call}
          onApply={(value) => void applyIcon(value)}
          onClose={() => setPickingIcon(false)}
          onBusyChange={setUploading}
        />
      )}
      {error && (
        <p className="project-error" role="alert">
          {error}
          <button type="button" className="secondary" onClick={() => retry.current()}>
            {t(locale, "save")}
          </button>
        </p>
      )}
    </div>
  );
}
