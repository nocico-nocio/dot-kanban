import type { ApiCall } from "./api-client";
import { useState } from "react";
import type { Service } from "../worker/routing";
import { t, type Locale } from "./i18n";
import { ServiceIcon } from "./ServiceIcon";
import { IconPickerModal } from "./IconPickerModal";
import { ProjectRegistration } from "./ProjectRegistration";
import { OverflowMenu } from "./OverflowMenu";

type SetServices = (update: (current: Service[]) => Service[]) => void;

function ServiceRow({
  service,
  locale,
  call,
  setServices,
  onRemove,
  disabled,
  onMove,
  index,
  services,
  dragging,
  setDragging,
}: {
  service: Service;
  locale: Locale;
  call: ApiCall;
  setServices: SetServices;
  onRemove: (id: string) => Promise<void>;
  disabled: boolean;
  onMove: (id: string, beforeId: string | null) => Promise<void>;
  index: number;
  services: Service[];
  dragging: string | null;
  setDragging: (id: string | null) => void;
}) {
  const [pickingIcon, setPickingIcon] = useState(false);
  const patch = (values: Partial<Service>) =>
    setServices((current) =>
      current.map((item) => (item.id === service.id ? { ...item, ...values } : item)),
    );
  return (
    <li
      className={`project-list-row ${dragging === service.id ? "dragging" : ""}`}
      onDragOver={(event) => {
        if (!disabled && dragging && dragging !== service.id) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!disabled && dragging && dragging !== service.id)
          void onMove(
            dragging,
            services.findIndex((item) => item.id === dragging) < index
              ? (services[index + 1]?.id ?? null)
              : service.id,
          );
        setDragging(null);
      }}
    >
      <button
        type="button"
        className="project-drag-handle"
        draggable={!disabled}
        disabled={disabled}
        aria-label={`${service.name}: ${t(locale, "reorderProjects")}`}
        title={t(locale, "reorderProjects")}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", service.id);
          setDragging(service.id);
        }}
        onDragEnd={() => setDragging(null)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" && index > 0) {
            event.preventDefault();
            void onMove(service.id, services[index - 1].id);
          }
          if (event.key === "ArrowDown" && index < services.length - 1) {
            event.preventDefault();
            void onMove(service.id, services[index + 2]?.id ?? null);
          }
        }}
      >
        <svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="5" r="1.4" />
          <circle cx="11" cy="5" r="1.4" />
          <circle cx="5" cy="10" r="1.4" />
          <circle cx="11" cy="10" r="1.4" />
          <circle cx="5" cy="15" r="1.4" />
          <circle cx="11" cy="15" r="1.4" />
        </svg>
      </button>
      <button
        type="button"
        className="project-icon-trigger"
        disabled={disabled}
        aria-label={`${service.name}: ${t(locale, "chooseIcon")}`}
        aria-haspopup="dialog"
        onClick={() => setPickingIcon(true)}
      >
        <ServiceIcon name={service.name} icon={service.icon} />
      </button>
      <input
        className="project-list-name"
        aria-label={t(locale, "projectName")}
        value={service.name}
        maxLength={120}
        disabled={disabled}
        placeholder={t(locale, "projectName")}
        onChange={(e) => patch({ name: e.target.value })}
      />
      <input
        className="project-list-repository"
        aria-label={`${service.name}: ${t(locale, "repository")}`}
        type="url"
        value={service.repository}
        maxLength={2000}
        disabled={disabled}
        placeholder={t(locale, "optionalRepository")}
        onChange={(e) => patch({ repository: e.target.value })}
      />
      <OverflowMenu label={`${service.name}: ${t(locale, "taskMenu")}`}>
        <button
          type="button"
          role="menuitem"
          disabled={disabled || index === 0}
          onClick={() => void onMove(service.id, services[index - 1].id)}
        >
          {t(locale, "moveUp")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={disabled || index === services.length - 1}
          onClick={() => void onMove(service.id, services[index + 2]?.id ?? null)}
        >
          {t(locale, "moveDown")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={disabled}
          onClick={() => {
            if (window.confirm(t(locale, "removeServiceConfirm"))) void onRemove(service.id);
          }}
        >
          {t(locale, "remove")}
        </button>
      </OverflowMenu>
      {pickingIcon && (
        <IconPickerModal
          name={service.name}
          value={service.icon}
          locale={locale}
          call={call}
          onApply={(icon) => {
            patch({ icon });
            setPickingIcon(false);
          }}
          onClose={() => setPickingIcon(false)}
        />
      )}
    </li>
  );
}

export function ServiceSettings({
  services,
  setServices,
  onRemove,
  locale,
  call,
  disabled,
  standalone = false,
  onCreate,
  onMove,
}: {
  standalone?: boolean;
  onCreate: (service: Service) => Promise<void>;
  onMove: (id: string, beforeId: string | null) => Promise<void>;
  services: Service[];
  setServices: SetServices;
  onRemove: (id: string) => Promise<void>;
  locale: Locale;
  call: ApiCall;
  disabled: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  return (
    <section className="setting-group service-settings" aria-labelledby="services-title">
      <div className="project-list-heading">
        <h2 id="services-title" className={standalone ? "project-count-heading" : undefined}>
          {t(locale, standalone ? "registeredProjects" : "services")}{" "}
          <span className="service-count">{services.length}</span>
        </h2>
        <button
          type="button"
          disabled={disabled || services.length >= 100 || adding}
          onClick={() => setAdding(true)}
        >
          ＋ {t(locale, "addProject")}
        </button>
      </div>
      {services.length ? (
        <ul className="project-list">
          {services.map((service, index) => (
            <ServiceRow
              key={service.id}
              service={service}
              index={index}
              services={services}
              dragging={dragging}
              setDragging={setDragging}
              onMove={onMove}
              locale={locale}
              call={call}
              setServices={setServices}
              onRemove={onRemove}
              disabled={disabled}
            />
          ))}
        </ul>
      ) : (
        <p className="project-list-empty">{t(locale, "noServices")}</p>
      )}
      {adding && (
        <ProjectRegistration
          locale={locale}
          call={call}
          services={services}
          onCancel={() => setAdding(false)}
          onCreate={async (service) => {
            await onCreate(service);
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}
