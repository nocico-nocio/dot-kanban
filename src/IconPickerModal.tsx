import type { ApiCall } from "./api-client";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconPicker, ServiceIcon } from "./ServiceIcon";
import { t, type Locale } from "./i18n";

export function IconPickerModal({
  name,
  value,
  locale,
  call,
  onApply,
  onClose,
  onBusyChange,
}: {
  name: string;
  value: string;
  locale: Locale;
  call: ApiCall;
  onApply: (icon: string) => void;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(value);
  const [uploading, setUploading] = useState(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      busyCallback.current?.(false);
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="icon-picker-modal"
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
          ),
        ).filter((item) => item.getClientRects().length > 0);
        const target = event.shiftKey ? items[items.length - 1] : items[0];
        if (document.activeElement === (event.shiftKey ? items[0] : items[items.length - 1])) {
          event.preventDefault();
          target?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="icon-modal-content">
        <header>
          <div>
            <h2 id={id}>{t(locale, "chooseIcon")}</h2>
            {name && <p>{name}</p>}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t(locale, "close")}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="icon-modal-preview">
          <ServiceIcon name={name} icon={draft} />
        </div>
        <IconPicker
          value={draft}
          onChange={setDraft}
          locale={locale}
          call={call}
          onBusyChange={(busy) => {
            setUploading(busy);
            busyCallback.current?.(busy);
          }}
        />
        <footer>
          <button type="button" className="secondary" onClick={onClose}>
            {t(locale, "cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={uploading}
            onClick={() => onApply(draft)}
          >
            {t(locale, "applyIcon")}
          </button>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
