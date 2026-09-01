import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  parseStudioHash,
  postStudioToParent,
  type OpenStudioDetail,
} from "../../lib/studioEmbed";
import { StudioApp } from "./StudioApp";
import { closeNativeStudio, openNativeStudio, useStudio } from "./studioStore";
import "./studio.css";

/**
 * Mount next to <App />. Listens for `duigao:open-studio` and `#studio`.
 * When embed=1, tells the parent frame it is ready.
 */
export function StudioRoot() {
  const session = useStudio();

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenStudioDetail>).detail;
      if (!detail) return;
      openNativeStudio({
        kind: detail.kind === "video" ? "video" : "poster",
        name: detail.name,
        width: detail.width,
        height: detail.height,
        embed: detail.embed,
        onExport: detail.onExport,
        onCancel: detail.onCancel,
      });
    };
    const onClose = () => closeNativeStudio();
    window.addEventListener("duigao:open-studio", onOpen);
    window.addEventListener("duigao:close-studio", onClose);

    const parsed = parseStudioHash(location.hash);
    if (parsed) {
      openNativeStudio({
        kind: parsed.kind,
        name: parsed.name || undefined,
        embed: parsed.embed || window.parent !== window,
      });
    }

    return () => {
      window.removeEventListener("duigao:open-studio", onOpen);
      window.removeEventListener("duigao:close-studio", onClose);
    };
  }, []);

  useEffect(() => {
    if (!session.open || !session.embed) return;
    postStudioToParent({ source: "inlay", type: "inlay:ready", payload: { version: 1 } });
  }, [session.open, session.embed]);

  if (!session.open) return null;
  return createPortal(<StudioApp />, document.body);
}
