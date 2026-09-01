import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { upgradeLegacyShareUrl } from "./cloud/legacy";
import "./styles.css";
import "./mobile.css";
import "./features/studio/studio.css";

// An old `#room=<6碼>` link opened by its owner becomes the real cloud invite
// URL before React reads the address bar, so the room loads the modern way and
// every later re-share carries the invite token (PR #16).
upgradeLegacyShareUrl();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* ignore SW errors in dev */
    });
  });
}
