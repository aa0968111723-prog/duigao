import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { upgradeLegacyShareUrl } from "./cloud/legacy";
import "./styles.css";
import "./mobile.css";

// An old `#room=<6碼>` link opened by its owner becomes the real cloud invite
// URL before React reads the address bar, so the room loads the modern way and
// every later re-share carries the invite token (PR #16).
upgradeLegacyShareUrl();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 單一 Suspense 邊界：lazy 的房間殼在進房那一刻載入（PR-08a）。 */}
    <Suspense fallback={null}>
      <App />
    </Suspense>
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* ignore SW errors in dev */
    });
  });
}
