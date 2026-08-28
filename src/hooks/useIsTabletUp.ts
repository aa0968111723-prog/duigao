import { useEffect, useState } from "react";

/**
 * 平板以上（WB05 Split View 的唯一判準）。
 *
 * **必須與 whiteboard.css 的 @media 條件逐字一致** — 兩邊分開寫遲早會漂，
 * 而漂掉的後果是「CSS 已經讓出側欄寬度、React 還沒掛側欄」的空白帶，
 * 或反過來「手機也掛了一份隱藏的討論面板」。
 *
 * 高度條件不可省：iPhone Pro Max 橫向有 926–956 CSS px 寬但只有 ~430px 高，
 * 只看寬度會讓手機橫向誤進平板版面。
 */
export const TABLET_UP_QUERY = "(min-width: 900px) and (min-height: 600px)";

export function useIsTabletUp(): boolean {
  const [tabletUp, setTabletUp] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(TABLET_UP_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(TABLET_UP_QUERY);
    const onChange = () => setTabletUp(mq.matches);
    mq.addEventListener("change", onChange);
    setTabletUp(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return tabletUp;
}
