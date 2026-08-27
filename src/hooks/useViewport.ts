import { useEffect, useState } from "react";

// `--kb` 可能同時有多個掛載者（討論殼的 composer 與疊在上面的對稿工作區都
// 需要它）。無條件 removeProperty 會讓「先卸載的那個」把還活著的使用者的
// 鍵盤高度歸零，所以用 ref-count：最後一個離開的人才清掉屬性。
let kbConsumers = 0;

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
    kbConsumers += 1;

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
      kbConsumers = Math.max(0, kbConsumers - 1);
      if (kbConsumers === 0) root.style.removeProperty("--kb");
    };
  }, []);

  return height;
}
