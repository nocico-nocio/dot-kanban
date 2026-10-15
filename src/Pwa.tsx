import { useEffect, useRef, useState } from "react";
import { t, type Locale } from "./i18n";

export function PwaStatus({ locale }: { locale: Locale }) {
  const [online, setOnline] = useState(navigator.onLine);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const refreshOnUpdate = useRef(false);
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    if (!("serviceWorker" in navigator))
      return () => {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      };
    let active = true;
    const onControllerChange = () => {
      if (refreshOnUpdate.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    void navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        if (!active) return;
        if (registration.waiting && navigator.serviceWorker.controller)
          setWaiting(registration.waiting);
        registration.addEventListener("updatefound", () => {
          registration.installing?.addEventListener("statechange", () => {
            if (registration.waiting && navigator.serviceWorker.controller && active)
              setWaiting(registration.waiting);
          });
        });
      })
      .catch(() => {});
    return () => {
      active = false;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);
  if (online && !waiting) return null;
  return (
    <div className="pwa-status">
      {!online && <p role="status">{t(locale, "offlineNeedsConnection")}</p>}
      {waiting && (
        <p role="status">
          {t(locale, "updateAvailable")}{" "}
          <button
            onClick={() => {
              refreshOnUpdate.current = true;
              waiting.postMessage({ type: "SKIP_WAITING" });
            }}
          >
            {t(locale, "updateNow")}
          </button>
        </p>
      )}
    </div>
  );
}
