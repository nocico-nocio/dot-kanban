import type { ApiCall } from "./api-client";
import { Fragment, useEffect, useRef, useState } from "react";
import { taskImages } from "../shared/task-images";
import { prepareTaskImage } from "./task-image";
import { t, type Locale } from "./i18n";

export function DescriptionContent({ value, locale }: { value: string; locale: Locale }) {
  let offset = 0;
  const parts = taskImages(value).map((image) => {
    const text = value.slice(offset, image.start);
    offset = image.end;
    return (
      <Fragment key={image.start}>
        {text}
        <a className="description-image" href={image.url} target="_blank" rel="noreferrer">
          <img src={image.url} alt={image.alt || t(locale, "attachedImage")} loading="lazy" />
        </a>
      </Fragment>
    );
  });
  return (
    <div className="description">
      {parts}
      {value.slice(offset) || (!value ? t(locale, "noDescription") : "")}
    </div>
  );
}

export function DescriptionEditor({
  value,
  locale,
  onChange,
  onCommit,
  call,
  onBusyChange,
  disabled = false,
}: {
  value: string;
  locale: Locale;
  onChange?: (value: string) => void;
  onCommit?: (value: string) => Promise<void>;
  call: ApiCall;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const text = useRef(value),
    saved = useRef(value),
    pending = useRef(false),
    picking = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const selection = useRef({ start: value.length, end: value.length });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onBusyChange?.(false);
    };
  }, [onBusyChange]);
  useEffect(() => {
    const input = fileInput.current;
    const cancel = () => {
      picking.current = false;
      textarea.current?.focus();
    };
    input?.addEventListener("cancel", cancel);
    return () => input?.removeEventListener("cancel", cancel);
  }, []);
  useEffect(() => {
    if (text.current === saved.current && !pending.current) {
      text.current = value;
      setDraft(value);
    }
    saved.current = value;
  }, [value]);
  const change = (next: string) => {
    text.current = next;
    setDraft(next);
    onChange?.(next);
  };
  const setPending = (next: boolean) => {
    pending.current = next;
    setBusy(next);
    onBusyChange?.(next);
  };
  const commit = async (next = text.current) => {
    if (!onCommit || next === saved.current || pending.current) return;
    setPending(true);
    setError("");
    try {
      await onCommit(next);
      saved.current = next;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  const upload = async (files: File[]) => {
    picking.current = false;
    if (!files.length || pending.current || disabled) return;
    const { start, end } = selection.current;
    setPending(true);
    setError("");
    let next = text.current;
    let inserted = "";
    let uploadError = "";
    try {
      for (const file of files) {
        // Reserve room before uploading so every successful upload can be inserted.
        if (text.current.length + inserted.length + 200 > 10000)
          throw new Error(t(locale, "descriptionTooLong"));
        const body = await prepareTaskImage(file);
        if (!mounted.current) return;
        const result = await call<{ url: string }>("/api/task-images", {
          method: "POST",
          headers: { "content-type": "image/png" },
          body,
        });
        if (!mounted.current) return;
        const alt =
          file.name.replace(/[\[\]\\\r\n]/g, "").slice(0, 80) || t(locale, "attachedImage");
        inserted += `\n![${alt}](${result.url})\n`;
        next = text.current.slice(0, start) + inserted + text.current.slice(end);
      }
    } catch (e) {
      const message = (e as Error).message;
      uploadError =
        message === "image_upload_invalid" || e instanceof DOMException
          ? t(locale, "image_upload_invalid")
          : message;
    } finally {
      if (mounted.current) {
        if (inserted) {
          change(next);
          selection.current = { start: start + inserted.length, end: start + inserted.length };
        }
        setPending(false);
      }
    }
    if (!mounted.current) return;
    if (inserted && onCommit) await commit(next);
    if (uploadError) setError(uploadError);
  };
  return (
    <div
      className="description-editor inline-text inline-description"
      onBlur={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          !picking.current &&
          !pending.current
        )
          void commit();
      }}
    >
      <textarea
        ref={textarea}
        aria-label={t(locale, "description")}
        value={draft}
        placeholder={t(locale, "description")}
        rows={6}
        maxLength={10000}
        disabled={busy || disabled}
        onChange={(event) => change(event.target.value)}
        onSelect={(event) => {
          selection.current = {
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          };
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (files.length) {
            event.preventDefault();
            selection.current = {
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            };
            void upload(files);
          }
        }}
        onKeyDown={(event) => {
          if (
            !event.nativeEvent.isComposing &&
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            void commit();
          }
          if (event.key === "Escape") change(saved.current);
        }}
      />
      <div className="description-tools">
        <button
          type="button"
          className="secondary"
          disabled={busy || disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            picking.current = true;
            fileInput.current?.click();
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8" cy="8" r="1.5" />
            <path d="m3 17 5-5 4 4 4-6 5 7" />
          </svg>
          {t(locale, "addImage")}
        </button>
        <span role={busy ? "status" : undefined}>
          {t(locale, busy ? "saving" : "imagePasteHint")}
        </span>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          aria-label={t(locale, "addImage")}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = "";
            void upload(files);
          }}
        />
      </div>
      {error && (
        <p className="project-error" role="alert">
          {error}
          {onCommit && (
            <button type="button" className="secondary" onClick={() => void commit()}>
              {t(locale, "save")}
            </button>
          )}
        </p>
      )}
      {taskImages(draft).length > 0 && (
        <div className="description-previews">
          {taskImages(draft).map((image) => (
            <figure key={image.start}>
              <a href={image.url} target="_blank" rel="noreferrer">
                <img src={image.url} alt={image.alt || t(locale, "attachedImage")} />
              </a>
              <button
                type="button"
                className="icon-button"
                aria-label={`${t(locale, "removeImage")}: ${image.alt}`}
                disabled={busy || disabled}
                onClick={() => {
                  const next = text.current.slice(0, image.start) + text.current.slice(image.end);
                  change(next);
                  void commit(next);
                }}
              >
                ×
              </button>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
