import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "pulling" | "ready" | "refreshing" | "done" | "failed";
const THRESHOLD = 80;

// Keep the page mounted: refresh data without losing filters or navigation.
export function usePullToRefresh(
  enabled: boolean,
  refresh: (signal: AbortSignal) => Promise<boolean>,
) {
  const surface = useRef<HTMLElement>(null);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    const element = surface.current;
    if (!enabled || !element) {
      setPhase("idle");
      return;
    }
    let gesture: {
      id: number;
      x: number;
      y: number;
      started: number;
      card: boolean;
      claimed: boolean;
      distance: number;
    } | null = null;
    let pending: AbortController | null = null;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const atTop = (target: Element) => {
      if (window.scrollY > 0) return false;
      for (let node: Element | null = target; node; node = node.parentElement) {
        if (node.scrollTop > 0) return false;
      }
      return true;
    };
    const cancel = () => {
      gesture = null;
      if (!pending) setPhase("idle");
    };
    const start = (event: TouchEvent) => {
      if (pending) return;
      cancel();
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.touches.length !== 1 ||
        !target ||
        !atTop(target) ||
        target.closest(
          'input, textarea, select, a, button:not(.task-card), [contenteditable], [role="menu"], .overlay',
        )
      )
        return;
      clearTimeout(timer);
      const point = event.touches[0];
      gesture = {
        id: point.identifier,
        x: point.clientX,
        y: point.clientY,
        started: Date.now(),
        card: !!target.closest("[data-task-id]"),
        claimed: false,
        distance: 0,
      };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      const point = Array.from(event.touches).find((touch) => touch.identifier === gesture?.id);
      if (event.touches.length !== 1 || !point) {
        cancel();
        return;
      }
      const dx = Math.abs(point.clientX - gesture.x);
      const dy = point.clientY - gesture.y;
      if (!gesture.claimed) {
        // A held card belongs to the board's long-press drag handler.
        if (gesture.card && Date.now() - gesture.started >= 250) {
          cancel();
          return;
        }
        if (Math.max(dx, Math.abs(dy)) < 8) return;
        if (dy <= 0 || dy < dx * 1.5 || !atTop(event.target as Element)) {
          cancel();
          return;
        }
        gesture.claimed = true;
      }
      if (!event.cancelable) {
        cancel();
        return;
      }
      event.preventDefault();
      gesture.distance = Math.max(0, dy);
      setPhase(gesture.distance >= THRESHOLD ? "ready" : "pulling");
    };
    const end = (event: TouchEvent) => {
      if (
        !gesture ||
        !Array.from(event.changedTouches).some((touch) => touch.identifier === gesture?.id)
      )
        return;
      const ready = gesture.claimed && gesture.distance >= THRESHOLD && event.touches.length === 0;
      if (gesture.claimed && event.cancelable) event.preventDefault();
      gesture = null;
      if (!ready) {
        setPhase("idle");
        return;
      }
      const controller = new AbortController();
      pending = controller;
      setPhase("refreshing");
      const timeout = setTimeout(() => controller.abort(), 15_000);
      // Race the abort too, so a disconnected server cannot leave a stuck spinner.
      const aborted = new Promise<boolean>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(false), { once: true }),
      );
      void Promise.race([latestRefresh.current(controller.signal), aborted])
        .catch(() => false)
        .then((ok) => {
          if (disposed) return;
          setPhase(ok ? "done" : "failed");
          timer = setTimeout(() => setPhase("idle"), ok ? 1200 : 3000);
        })
        .finally(() => {
          clearTimeout(timeout);
          pending = null;
        });
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    document.documentElement.classList.add("pull-refresh-enabled");
    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end, { passive: false });
    element.addEventListener("touchcancel", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      pending?.abort();
      document.documentElement.classList.remove("pull-refresh-enabled");
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled]);

  return { surface, phase, refreshing: phase === "refreshing" };
}
