import { useEffect, useRef, useState, type ReactNode } from "react";
export function OverflowMenu({
  label,
  children,
  triggerContent = "⋮",
  triggerClassName = "overflow-trigger",
  disabled = false,
  title,
}: {
  label: string;
  children: ReactNode;
  triggerContent?: ReactNode;
  triggerClassName?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div
      ref={root}
      className="overflow-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = Array.from(
            root.current?.querySelectorAll<HTMLButtonElement>(
              '[role^="menuitem"]:not(:disabled)',
            ) || [],
          );
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[
            index < 0
              ? event.key === "ArrowDown"
                ? 0
                : items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
          ]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={triggerClassName}
        title={title}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {triggerContent}
      </button>
      {open && (
        <div
          className="overflow-popover"
          role="menu"
          aria-label={label}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button:not(:disabled)")) {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
