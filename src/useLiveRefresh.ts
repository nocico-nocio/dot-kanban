import { useEffect, useRef } from "react";

const INTERVAL_MS = 3_000;
const MAX_RETRY_MS = 30_000;

// Poll a single revision, fetching board data only when it changes. Keep the
// observed revision until the corresponding board fetch has actually succeeded.
export function useLiveRefresh(
  enabled: boolean,
  refresh: (signal: AbortSignal) => Promise<boolean>,
) {
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let etag: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: AbortController | null = null;
    let retry = INTERVAL_MS;
    let dragging = false;
    let touching = false;
    const pointers = new Set<number>();
    const active = () =>
      !disposed &&
      !document.hidden &&
      navigator.onLine &&
      !dragging &&
      !touching &&
      pointers.size === 0;
    const schedule = (delay = retry) => {
      clearTimeout(timer);
      if (active() && !pending) timer = setTimeout(check, delay);
    };
    const check = async () => {
      if (!active() || pending) return;
      const controller = new AbortController();
      pending = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch("/api/board/revision", {
          headers: etag ? { "if-none-match": etag } : {},
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status !== 304) {
          if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
            throw new Error("Revision unavailable");
          const value = (await response.json()) as { revision?: number };
          const nextEtag = response.headers.get("etag");
          if (!Number.isSafeInteger(value.revision) || !nextEtag)
            throw new Error("Invalid revision");
          if (!active() || controller.signal.aborted) return;
          if (!(await latestRefresh.current(controller.signal)))
            throw new Error("Board refresh failed");
          if (!controller.signal.aborted) etag = nextEtag;
        }
        retry = INTERVAL_MS;
      } catch {
        // Retain the last successful board and retry; do not replace an editing
        // error or clear a draft because a background request failed.
        retry = Math.min(retry * 2, MAX_RETRY_MS);
      } finally {
        clearTimeout(timeout);
        if (pending === controller) pending = null;
        schedule();
      }
    };
    const pause = () => {
      clearTimeout(timer);
      pending?.abort();
    };
    const resume = () => {
      retry = INTERVAL_MS;
      schedule(0);
    };
    const visibility = () => {
      if (document.hidden) {
        pointers.clear();
        dragging = false;
        touching = false;
        pause();
      } else resume();
    };
    const pointerDown = (event: PointerEvent) => {
      pointers.add(event.pointerId);
      pause();
    };
    const pointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      resume();
    };
    const dragStart = () => {
      dragging = true;
      pause();
    };
    const dragEnd = () => {
      dragging = false;
      pointers.clear();
      resume();
    };
    const touchStart = () => {
      touching = true;
      pause();
    };
    const touchEnd = (event: TouchEvent) => {
      touching = event.touches.length > 0;
      resume();
    };
    const blur = (event: Event) => {
      if (event.target !== window) return;
      pointers.clear();
      dragging = false;
      touching = false;
      pause();
    };
    const focus = (event: Event) => {
      if (event.target === window) resume();
    };
    const listeners = {
      pointerdown: pointerDown,
      pointerup: pointerUp,
      pointercancel: pointerUp,
      dragstart: dragStart,
      dragend: dragEnd,
      drop: dragEnd,
      touchstart: touchStart,
      touchend: touchEnd,
      touchcancel: touchEnd,
      online: resume,
      offline: pause,
      blur,
      focus,
    };
    for (const [name, listener] of Object.entries(listeners))
      window.addEventListener(name, listener as EventListener, { capture: true, passive: true });
    document.addEventListener("visibilitychange", visibility);
    schedule(0);
    return () => {
      disposed = true;
      pause();
      for (const [name, listener] of Object.entries(listeners))
        window.removeEventListener(name, listener as EventListener, true);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled]);
}
