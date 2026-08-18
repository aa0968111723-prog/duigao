import { useEffect, useState } from "react";

const QUERY =
  "(max-width: 720px), (orientation: landscape) and (max-height: 520px) and (max-width: 920px) and (pointer: coarse)";

/**
 * Single source of truth for rendering the phone shell. Width alone is not
 * enough: many phones become 800–900px wide in landscape, so a short coarse-
 * pointer landscape viewport still stays in the mobile workspace.
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}
