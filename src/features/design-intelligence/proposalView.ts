/**
 * Design Intelligence — 提案呈現的純邏輯（PR-DI-04）
 *
 * 這個檔案裡沒有 React。理由是這一層的每一個決定都**應該可以被斷言**：
 * 手機上現在顯示第幾個方案、這一下滑動算不算換頁、套用按鈕為什麼是灰的。
 * 把它們留在元件裡，就只能靠「畫面上有沒有那個元素」來測，而那正是我在
 * 白板那幾輪反覆踩到的假綠。
 *
 * 任務書第十四、十五節的三條要求，在這裡各有一個對應的函式：
 *   - AI 不得佔據主畫面 → `layoutFor` 回的是「疊在上面的一層」的尺寸上限
 *   - 手機一次看一個方案，用滑動切換 → `swipeIntent` + `nextAlternativeIndex`
 *   - 套用前必須人類確認 → `applyGate`
 */
import type { DesignProposal, Diagnostic, Severity } from "./types";

// ---------------------------------------------------------------------------
// 版面
// ---------------------------------------------------------------------------

export type PanelLayout =
  /** 手機：底部抽屜，蓋住畫面的一部分，隨時可以收起來。 */
  | { kind: "sheet"; maxHeightRatio: number; peekPx: number }
  /** 平板以上：側邊分割，主畫面仍然看得到。 */
  | { kind: "split"; widthPx: number };

export type ViewportInfo = {
  width: number;
  height: number;
  /** 觸控裝置。橫放的手機很寬，光看寬度會誤判成平板。 */
  coarsePointer: boolean;
};

/**
 * 決定 AI 面板怎麼出現。
 *
 * **AI 不得佔據主畫面**（任務書第十四節），所以兩種版面都刻意留白：
 *   - 手機的抽屜最高只到 76%，永遠看得到上面的作品。
 *   - 平板的分割欄有寬度上限，而且不超過視窗的 40%。
 *
 * 判斷用的是 `useIsMobile` 的同一套條件（寬度 + 橫放的矮螢幕 + 粗指標），
 * 不是只看寬度 —— 很多手機橫放時有 800–900px 寬。
 */
export function layoutFor(viewport: ViewportInfo): PanelLayout {
  const phoneByWidth = viewport.width <= 720;
  const phoneLandscape =
    viewport.coarsePointer && viewport.height <= 520 && viewport.width <= 920;
  if (phoneByWidth || phoneLandscape) {
    // peek 要有上限：極矮的視窗（軟鍵盤彈出、分割視窗、桌機瀏覽器被拉扁）下，
    // 固定的 56px 會蓋掉大半個畫面 —— 對抗審查用 360×56 打出來的。
    //
    // **這裡有一個真實的取捨**：12% 的上限與「把手至少要 32px 才按得到」
    // 在很矮的視窗上會衝突（56px 高的視窗，12% 只有 7px）。
    // 選擇讓 32px 的下限勝出 —— 一個按不到的把手比一個稍微佔位的把手更糟，
    // 而且視窗矮到那種程度時，任何 UI 都已經不能用了。
    //
    // 也就是說：視窗高於約 270px 時遵守 12%；低於就退回 32px 並接受它佔比高。
    const peekPx = Math.max(32, Math.min(56, Math.round(viewport.height * 0.12)));
    return { kind: "sheet", maxHeightRatio: 0.76, peekPx };
  }
  // 平板：分割欄佔 38%，但夾在 320–420px 之間 —— 太窄讀不了診斷，
  // 太寬就變成 AI 佔據主畫面。
  const width = Math.round(viewport.width * 0.38);
  return { kind: "split", widthPx: Math.max(320, Math.min(420, width)) };
}

/**
 * 面板實際會蓋住主畫面的比例。用來斷言「沒有佔據主畫面」。
 *
 * 抽屜要看**現在是不是展開的**：收起來時只有一條（peek），展開才是上限。
 * 舊版一律回 `maxHeightRatio`，函式名字說「實際佔用」但回的是最壞情況 ——
 * 名實不符的函式在稽核時會給出錯誤的安全感。
 */
export function occupiedRatio(
  layout: PanelLayout,
  viewport: ViewportInfo,
  expanded = true,
): number {
  if (layout.kind === "sheet") {
    const heightPx = expanded ? viewport.height * layout.maxHeightRatio : layout.peekPx;
    return heightPx / viewport.height;
  }
  return layout.widthPx / viewport.width;
}

// ---------------------------------------------------------------------------
// 手機：一次一個方案
// ---------------------------------------------------------------------------

export type SwipeSample = {
  dx: number;
  dy: number;
  /** 毫秒。快速的短滑動也算換頁。 */
  elapsedMs: number;
};

/**
 * 這一下滑動要不要換頁。
 *
 * 三個條件，缺一不可：
 *   1. 水平位移夠大（或速度夠快）。
 *   2. 水平位移明顯大於垂直位移 —— 否則使用者只是想捲動診斷清單。
 *   3. 不是幾乎沒動（誤觸）。
 *
 * 第 2 條是重點：抽屜裡是可捲動的內容，把斜向的手勢當成換頁會讓人捲不動。
 */
export function swipeIntent(sample: SwipeSample): "prev" | "next" | null {
  const absX = Math.abs(sample.dx);
  const absY = Math.abs(sample.dy);
  if (absX < 12) return null;                    // 誤觸
  // 比例 2.0：水平位移要有垂直的兩倍才算換頁。
  //
  // 這一條自己就處理掉所有的捲動情境（-70/49 與 -80/57 都被擋下）。
  // 曾經另外加過一個「垂直位移不得超過 40px」的絕對上限，但變異測試指出
  // 它殺不死 —— 而追下去發現它不只冗餘，還**有害**：
  // 「水平 200px、垂直 60px」是一次明確的滑動意圖，那個上限會把它擋掉。
  // 已移除。
  if (absX < absY * 2) return null;              // 主要是垂直，讓它捲動
  const fast = sample.elapsedMs > 0 && absX / sample.elapsedMs > 0.5; // px/ms
  if (absX < 56 && !fast) return null;           // 慢速的短滑動不算
  return sample.dx < 0 ? "next" : "prev";
}

/**
 * 換頁後的索引。**不繞回**：滑到最後一個再往左不會跳回第一個。
 *
 * 繞回在只有三個項目時特別容易讓人以為自己滑錯方向 —— 手機上沒有其他線索
 * 可以判斷現在在哪裡，除了頁面指示點。
 */
export function nextAlternativeIndex(
  current: number,
  count: number,
  direction: "prev" | "next",
): number {
  if (count <= 0) return 0;
  const target = direction === "next" ? current + 1 : current - 1;
  return Math.max(0, Math.min(count - 1, target));
}

// ---------------------------------------------------------------------------
// 顯示什麼
// ---------------------------------------------------------------------------

export type PanelState =
  | { kind: "analyzing"; note: string }
  /** 有結果可以看。 */
  | { kind: "result"; diagnostics: Diagnostic[]; alternativeCount: number }
  /** 有結論但不是「找到問題」—— 例如作品沒問題，或資料不足。 */
  | { kind: "notice"; title: string; detail: string; actionable: boolean }
  | {
      kind: "failed";
      title: string;
      detail: string;
      retryable: boolean;
      /** 重試的對象：重跑分析，還是重試套用。兩者的按鈕接的不是同一個東西。 */
      retryOf: "analysis" | "apply";
    };

const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/** 診斷排序：嚴重的在前；同樣嚴重時，量出來的排在模型說的前面。 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.measured !== b.measured) return a.measured ? -1 : 1;
    return b.confidence - a.confidence;
  });
}

/**
 * 面板現在該顯示什麼。
 *
 * 「沒有找到問題」與「分析失敗」與「資料不足」是三件完全不同的事，
 * 使用者的下一步也完全不同 —— 混成一句「沒有結果」就等於什麼都沒說。
 */
export function panelStateFor(proposal: DesignProposal): PanelState {
  if (proposal.status === "analyzing" || proposal.status === "draft") {
    return { kind: "analyzing", note: "正在分析這件作品…" };
  }
  if (proposal.status === "failed") {
    // `baseRevision` 有值代表已經進過 applying —— 也就是**作品可能已經被動過**。
    // 那和「分析沒跑完」是完全不同的處境，訊息與可用的動作都不一樣。
    const duringApply = proposal.baseRevision !== null;
    return {
      kind: "failed",
      title: duringApply ? "套用沒有完成，作品可能已經被更動" : "這次分析沒有完成",
      // **不要用 risks[0]。** 那是歷史紀錄的第一條，不是這次的失敗原因。
      detail: proposal.failureReason ?? "沒有取得失敗原因",
      retryable: true,
      retryOf: duringApply ? "apply" : "analysis",
    };
  }
  if (proposal.status === "needs-context") {
    return {
      kind: "notice",
      title: "還不能分析",
      detail: proposal.risks[0] ?? "需要更多資料才能判斷",
      actionable: true,
    };
  }
  // 已經被處理過的提案不該再顯示「沒有找到問題」—— 那是分析剛結束時的訊息。
  // 對抗審查實測：`status: "approved"` 但內容為空時，舊版會說「沒有找到可以
  // 量測的問題」，而使用者剛剛才核准過它。
  const PROCESSED: Record<string, string> = {
    approved: "這個提案已經核准，等待套用",
    applying: "正在套用…",
    applied: "這個提案已經套用完成",
    rejected: "這個提案已經被否決",
    reverted: "這個提案已經復原",
  };
  const processed = PROCESSED[proposal.status];
  if (processed) {
    return {
      kind: "notice",
      title: processed,
      detail: proposal.rationale || "沒有其他說明",
      actionable: false,
    };
  }

  if (!proposal.diagnostics.length && !proposal.alternatives.length) {
    return {
      kind: "notice",
      title: "沒有找到可以量測的問題",
      detail: "對比、字級、觸控目標尺寸都在建議範圍內。這不代表設計無法再進步，只代表沒有量得出來的問題。",
      actionable: false,
    };
  }
  return {
    kind: "result",
    diagnostics: sortDiagnostics(proposal.diagnostics),
    alternativeCount: proposal.alternatives.length,
  };
}

// ---------------------------------------------------------------------------
// 套用閘門
// ---------------------------------------------------------------------------

export type ApplyGate =
  | { enabled: true }
  | { enabled: false; reason: string };

/**
 * 套用按鈕能不能按。
 *
 * 任務書：「不得直接：使用者一句話 → AI 覆蓋原稿」。所以這個函式的預設是
 * **不能按**，而且每一種不能按都要說得出理由 —— 一個沒有說明的灰色按鈕
 * 只會讓人以為系統壞了。
 */
export function applyGate(
  proposal: DesignProposal,
  selectedAlternativeId: string | null,
  /**
   * 這個人有沒有權限改這件作品（對應 `can_manage_media`）。
   *
   * **沒有預設值，而且刻意如此。** 權限檢查的預設值是 `true` 等於「忘了傳
   * 就全部放行」—— 那正是這個參數要防的事。房間裡的 reviewer 看得到提案，
   * 但不該能把它套到別人的作品上。
   *
   * 對抗審查兩次指出這裡：第一次是完全沒有角色檢查，第二次是預設值太寬鬆。
   */
  canApply: boolean,
): ApplyGate {
  if (!canApply) return { enabled: false, reason: "你在這個房間沒有修改作品的權限" };
  if (proposal.status === "applied") return { enabled: false, reason: "這個提案已經套用過了" };
  if (proposal.status === "applying") return { enabled: false, reason: "正在套用…" };
  if (proposal.status === "rejected") return { enabled: false, reason: "這個提案已經被否決" };
  if (proposal.status !== "ready" && proposal.status !== "approved") {
    return { enabled: false, reason: "分析還沒完成" };
  }
  if (!proposal.alternatives.length) {
    return { enabled: false, reason: "這次只有診斷，沒有可以套用的方案" };
  }
  if (!selectedAlternativeId) {
    return { enabled: false, reason: "請先選一個方案" };
  }
  if (!proposal.alternatives.some((alternative) => alternative.id === selectedAlternativeId)) {
    return { enabled: false, reason: "選到的方案已經不在這份提案裡，請重新整理" };
  }
  return { enabled: true };
}

/**
 * 套用之後會發生什麼、怎麼還原 —— 在按下去之前就要說。
 *
 * 「按下去才知道會發生什麼」是這個功能最容易造成傷害的地方：
 * 使用者的原稿是他們花時間做的。
 */
export function applyPreviewText(
  proposal: DesignProposal,
  selectedAlternativeId: string | null,
): { changeCount: number; summary: string[]; revertNote: string } {
  const alternative = proposal.alternatives.find((item) => item.id === selectedAlternativeId);
  if (!alternative) {
    return { changeCount: 0, summary: [], revertNote: "沒有選擇方案" };
  }
  return {
    changeCount: alternative.changes.length,
    summary: alternative.changes.map((change) => `${change.target}：${change.change}`),
    revertNote: proposal.patch?.revertHint ?? "套用前會先存一個版本，隨時可以回到原稿",
  };
}
