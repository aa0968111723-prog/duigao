/**
 * 觸控筆仲裁（WB05）— 純函式，零 DOM。
 *
 * 平板上「手寫」和「用手操作」是兩種不同的輸入，混在一起是最常見的
 * 破壞性體驗：手掌落在畫布上時筆畫斷掉、或掌側拖走整個畫面。
 *
 * 規則（與 Freeform／Notability 一致，使用者不用學）：
 * - **筆優先**：pointerType === "pen" 一律進筆畫，不需要先切繪圖工具。
 * - **掌拒**：筆按下期間，所有 touch pointer 一律忽略（連 pinch 都不給）。
 *   筆抬起後有一小段寬限期，因為手掌常常比筆晚離開。
 * - 手指維持既有語意（平移／縮放／選取），繪圖工具開著時才畫。
 * - 滑鼠不受掌拒影響（桌機沒有手掌問題）。
 */
export type PointerKind = "pen" | "touch" | "mouse";

export const PALM_GRACE_MS = 250;

export type PenState = {
  /** 目前握筆中的 pointerId（null＝沒有筆在畫）。 */
  penPointerId: number | null;
  /** 筆最後一次抬起的時間 — 寬限期內仍拒絕手掌。 */
  penUpAt: number;
};

export function initialPenState(): PenState {
  return { penPointerId: null, penUpAt: Number.NEGATIVE_INFINITY };
}

/**
 * 這個 pointer 事件該不該被丟掉（掌拒）。
 * 只影響 touch：滑鼠與筆永遠通過。
 */
export function shouldRejectPointer(
  state: PenState,
  kind: PointerKind,
  now: number,
  graceMs = PALM_GRACE_MS,
): boolean {
  if (kind !== "touch") return false;
  if (state.penPointerId !== null) return true;
  return now - state.penUpAt < graceMs;
}

export function penDown(state: PenState, pointerId: number): PenState {
  return { ...state, penPointerId: pointerId };
}

export function penUp(state: PenState, pointerId: number, now: number): PenState {
  if (state.penPointerId !== pointerId) return state;
  return { penPointerId: null, penUpAt: now };
}

/**
 * 筆壓 → 線寬。
 *
 * `undefined`＝這個輸入沒有壓感資料（手指／滑鼠）→ 基準寬度。
 * `0`＝**壓得最輕**，不是「沒有資料」—— 把 0 當沒資料會讓起收筆的漸細
 * 反過來變最粗（自審 N8 實抓）。Pointer Events 規格：不支援壓感的筆在
 * 按下時回報 0.5，所以 0 一定是真實的最小壓力。
 */
export function widthForPressure(base: number, pressure: number | undefined): number {
  if (typeof pressure !== "number" || !Number.isFinite(pressure)) return base;
  // 0.35×～1.6× 之間：太細會看不見，太粗在小節點上糊成一團
  const clamped = Math.min(1, Math.max(0, pressure));
  return Number((base * (0.35 + clamped * 1.25)).toFixed(3));
}

/** 一段一段的線寬（相鄰兩點取平均，避免單點突刺）。 */
export function segmentWidths(pressures: (number | undefined)[], base: number): number[] {
  const widths: number[] = [];
  for (let i = 1; i < pressures.length; i += 1) {
    const a = pressures[i - 1];
    const b = pressures[i];
    const mean = typeof a === "number" && typeof b === "number" ? (a + b) / 2 : (b ?? a);
    widths.push(widthForPressure(base, mean));
  }
  return widths;
}

/**
 * 把逐段線寬壓成「同寬的連續段」（自審：一筆手寫變成數百個 SVG 元素，
 * 每個平移／縮放影格都要重新協調）。
 *
 * 相鄰段的寬度四捨五入到同一個 0.5px 桶就併成一段 polyline。壓感的視覺
 * 差異保留得住（0.5px 以下人眼本來就分不出），元素數卻從「點數−1」掉到
 * 「粗細真的變化的次數」——平穩運筆常常只剩個位數。
 */
export function strokeRuns(
  points: [number, number][],
  widths: number[],
  bucket = 0.5,
): Array<{ width: number; points: [number, number][] }> {
  if (points.length < 2 || widths.length !== points.length - 1) return [];
  const runs: Array<{ width: number; points: [number, number][] }> = [];
  let current: { width: number; points: [number, number][] } | null = null;
  for (let i = 0; i < widths.length; i += 1) {
    const width = Math.round(widths[i] / bucket) * bucket;
    if (!current || current.width !== width) {
      // 新的一段從上一段的末點接起來，線才不會斷開
      current = { width, points: [points[i], points[i + 1]] };
      runs.push(current);
    } else {
      current.points.push(points[i + 1]);
    }
  }
  return runs;
}
