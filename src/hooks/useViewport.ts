import { useEffect, useState } from "react";

/**
 * Publishes the on-screen keyboard height as `--kb` so fixed sheets can sit on
 * top of it instead of being pushed off-screen, and returns the usable height
 * for sheet snap points. Falls back cleanly when visualViewport is missing.
 */
export function useViewport(): number {
  const [height, setHeight] = useState(() => window.visualViewport?.height ?? window.innerHeight);

  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;

    const update = () => {
      if (vv) {
        const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        root.style.setProperty("--kb", `${Math.round(inset)}px`);
        setHeight(vv.height);
      } else {
        setHeight(window.innerHeight);
      }
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      root.style.removeProperty("--kb");
    };
  }, []);

  return height;
}
