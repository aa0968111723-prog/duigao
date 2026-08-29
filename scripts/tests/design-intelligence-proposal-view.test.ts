/**
 * 提案呈現邏輯的測試（PR-DI-04）。
 *
 * 這些斷言的對象是**使用者感受得到的事實**：面板會不會蓋住主畫面、
 * 斜著滑會不會被當成換頁、套用按鈕為什麼是灰的。
 *
 * 版面決策留在純函式裡就是為了能這樣測 —— 留在元件裡的話，只能靠
 * 「畫面上有沒有那個元素」，而那是假綠的溫床。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  applyGate,
  applyPreviewText,
  layoutFor,
  nextAlternativeIndex,
  occupiedRatio,
  panelStateFor,
  sortDiagnostics,
  swipeIntent,
} from "../../src/features/design-intelligence/proposalView";
import { transitionProposal } from "../../src/features/design-intelligence/lifecycle";
import type {
  DesignAlternative,
  DesignProposal,
  Diagnostic,
} from "../../src/features/design-intelligence/types";

function diagnostic(over: Partial<Diagnostic> & Pick<Diagnostic, "id">): Diagnostic {
  return {
    location: "位置",
    issue: "問題",
    impact: "影響",
    evidence: "量測 1.0",
    recommendation: "建議 2.0",
    severity: "minor",
    confidence: 0.8,
    measured: false,
    ...over,
  };
}

function alternative(id: string, changes = 1): DesignAlternative {
  return {
    id,
    name: id,
    strategy: "conservative",
    changes: Array.from({ length: changes }, (_, index) => ({
      dimension: "color" as const,
      target: `目標 ${index}`,
      change: `改成值 ${index}`,
      reason: "理由",
    })),
    designTokens: [],
    preview: null,
    advantages: [],
    tradeoffs: [],
  };
}

function proposal(over: Partial<DesignProposal> = {}): DesignProposal {
  return {
    id: "p-1",
    roomId: "room-1",
    projectId: "room-1",
    artifactId: null,
    targetType: "poster",
    targetId: "poster-1",
    mode: "improve",
    goal: "目標",
    contextSummary: "摘要",
    diagnostics: [diagnostic({ id: "d-1" })],
    alternatives: [alternative("a-1")],
    recommendedAlternativeId: "a-1",
    preview: null,
    patch: null,
    rationale: "理由",
    sources: [],
    risks: [],
    confidence: 0.6,
    status: "ready",
    createdBy: "user-1",
    createdAt: 1,
    approvedBy: null,
    approvedAt: null,
    appliedAt: null,
    revertedAt: null,
    failureReason: null,
    baseRevision: null,
    resultRevision: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 版面：AI 不得佔據主畫面
// ---------------------------------------------------------------------------

test("五種要求驗證的尺寸都不會讓 AI 佔據主畫面", () => {
  // 任務書第二十二節指定的五個尺寸。
  const sizes: Array<[string, number, number, boolean]> = [
    ["小手機 360×800", 360, 800, true],
    ["iPhone 390×844", 390, 844, true],
    ["大手機 412×915", 412, 915, true],
    ["iPad 768×1024", 768, 1024, true],
    ["iPad Pro 820×1180", 820, 1180, true],
  ];
  for (const [label, width, height, coarse] of sizes) {
    const viewport = { width, height, coarsePointer: coarse };
    const layout = layoutFor(viewport);
    // 展開時（最壞情況）
    const expanded = occupiedRatio(layout, viewport, true);
    assert.ok(
      expanded <= 0.8,
      `${label}：展開時 AI 面板佔了 ${Math.round(expanded * 100)}%，主畫面被吃掉了`,
    );
    // 收起時（手機的預設狀態）—— 一打開就吃掉大半個畫面是很糟的第一印象
    const collapsed = occupiedRatio(layout, viewport, false);
    if (layout.kind === "sheet") {
      assert.ok(
        collapsed <= 0.12,
        `${label}：收起的抽屜佔了 ${Math.round(collapsed * 100)}%，太高了`,
      );
      assert.ok(collapsed < expanded, "收起與展開必須是不同的值 —— 否則這個函式沒有在算實際值");
    }
  }
});

test("手機用底部抽屜，平板用側邊分割", () => {
  assert.equal(layoutFor({ width: 360, height: 800, coarsePointer: true }).kind, "sheet");
  assert.equal(layoutFor({ width: 390, height: 844, coarsePointer: true }).kind, "sheet");
  assert.equal(layoutFor({ width: 412, height: 915, coarsePointer: true }).kind, "sheet");
  assert.equal(layoutFor({ width: 768, height: 1024, coarsePointer: true }).kind, "split");
  assert.equal(layoutFor({ width: 820, height: 1180, coarsePointer: true }).kind, "split");
});

test("橫放的手機仍然用抽屜，不會因為變寬就被當成平板", () => {
  // 很多手機橫放時是 800–900px 寬。只看寬度會把它當平板，
  // 而 380px 高的側邊欄根本放不下東西。
  const landscapePhone = { width: 896, height: 414, coarsePointer: true };
  assert.equal(layoutFor(landscapePhone).kind, "sheet", "橫放手機該用抽屜");

  // 但同樣寬度的桌機（細指標）是分割
  assert.equal(layoutFor({ width: 896, height: 414, coarsePointer: false }).kind, "split");
});

test("平板的分割欄有寬度上限，不會隨螢幕無限變寬", () => {
  const wide = layoutFor({ width: 2560, height: 1440, coarsePointer: false });
  assert.equal(wide.kind, "split");
  if (wide.kind !== "split") return;
  assert.ok(wide.widthPx <= 420, `分割欄 ${wide.widthPx}px 太寬，AI 開始佔據主畫面`);

  const narrow = layoutFor({ width: 768, height: 1024, coarsePointer: true });
  if (narrow.kind !== "split") return;
  assert.ok(narrow.widthPx >= 320, `分割欄 ${narrow.widthPx}px 太窄，診斷讀不了`);
});

// ---------------------------------------------------------------------------
// 手機：一次一個方案，滑動切換
// ---------------------------------------------------------------------------

test("斜著滑不會被當成換頁（否則抽屜捲不動）", () => {
  // 使用者想捲動診斷清單時，手指幾乎一定會有一點水平位移。
  assert.equal(swipeIntent({ dx: 40, dy: 120, elapsedMs: 300 }), null, "主要是垂直，應該讓它捲動");
  assert.equal(swipeIntent({ dx: -50, dy: 90, elapsedMs: 300 }), null);
  // 水平明顯佔優才換頁
  assert.equal(swipeIntent({ dx: -90, dy: 20, elapsedMs: 300 }), "next");
  assert.equal(swipeIntent({ dx: 90, dy: 20, elapsedMs: 300 }), "prev");
});

test("誤觸與慢速的短滑動不換頁，快速的短滑動要換", () => {
  assert.equal(swipeIntent({ dx: -8, dy: 2, elapsedMs: 100 }), null, "誤觸");
  assert.equal(swipeIntent({ dx: -30, dy: 5, elapsedMs: 400 }), null, "慢速短滑動");
  assert.equal(
    swipeIntent({ dx: -30, dy: 5, elapsedMs: 40 }),
    "next",
    "快速的短滑動（0.75 px/ms）是明確的換頁意圖",
  );
});

test("滑到頭不會繞回第一個", () => {
  // 只有三個項目時，繞回會讓人以為自己滑錯方向。
  assert.equal(nextAlternativeIndex(2, 3, "next"), 2, "最後一個再往左應該停住");
  assert.equal(nextAlternativeIndex(0, 3, "prev"), 0, "第一個再往右應該停住");
  assert.equal(nextAlternativeIndex(0, 3, "next"), 1);
  assert.equal(nextAlternativeIndex(2, 3, "prev"), 1);
  // 邊界：沒有方案時不會炸
  assert.equal(nextAlternativeIndex(0, 0, "next"), 0);
});

// ---------------------------------------------------------------------------
// 顯示什麼
// ---------------------------------------------------------------------------

test("「沒問題」「資料不足」「分析失敗」是三種不同的訊息", () => {
  const clean = panelStateFor(proposal({ diagnostics: [], alternatives: [], status: "ready" }));
  assert.equal(clean.kind, "notice");
  if (clean.kind === "notice") {
    assert.match(clean.title, /沒有找到可以量測的問題/);
    // 誠實：沒有量得出來的問題 ≠ 設計已經完美
    assert.match(clean.detail, /不代表設計無法再進步/);
    assert.equal(clean.actionable, false);
  }

  const needsContext = panelStateFor(
    proposal({ status: "needs-context", diagnostics: [], alternatives: [], risks: ["需要作品的色碼"] }),
  );
  assert.equal(needsContext.kind, "notice");
  if (needsContext.kind === "notice") {
    assert.equal(needsContext.actionable, true, "資料不足是使用者可以處理的");
    assert.match(needsContext.detail, /色碼/);
  }

  const failed = panelStateFor(
    proposal({
      status: "failed",
      failureReason: "AI 分析沒有完成（503 上游無回應）",
      risks: ["AI 分析沒有完成（503 上游無回應）"],
    }),
  );
  assert.equal(failed.kind, "failed");
  if (failed.kind === "failed") {
    assert.match(failed.detail, /503/, "失敗原因要照實顯示，不能用「請稍後再試」蓋掉");
    assert.equal(failed.retryable, true);
    assert.equal(failed.retryOf, "analysis", "還沒進 applying，重試的是分析");
  }
});

test("套用失敗顯示的是這次的原因，不是歷史紀錄的第一條", () => {
  // 實測到的：無金鑰的預設設定下，每個 ready 提案都已經帶著 risks
  //（「沒有可用的 AI」「只提供了一個保守方案」），而 lifecycle 把失敗原因
  // append 到**尾巴**。讀取端取 risks[0] 拿到的是完全無關的舊訊息，
  // 而使用者唯一能拿去處理的資訊完全不顯示。
  const REASON = "套用失敗：Canva API 回 500（board adapter 沒有寫入權限）";
  const ready = proposal({
    risks: [
      "只提供了一個保守方案：平衡重設計與大膽創意需要創意判斷",
      "目前沒有可用的 AI 分析服務，以下只有本地量測得出的結果",
    ],
    patch: { adapter: "board", payload: {}, reversible: true, revertHint: "回到上一版" },
  });
  const now = () => 2;
  const approved = transitionProposal(ready, "approved", { now, actor: "user-2" });
  assert.ok(approved.ok);
  if (!approved.ok) return;
  const applying = transitionProposal(approved.proposal, "applying", { now, baseRevision: "v3" });
  assert.ok(applying.ok);
  if (!applying.ok) return;
  const failed = transitionProposal(applying.proposal, "failed", { now, reason: REASON });
  assert.ok(failed.ok);
  if (!failed.ok) return;

  const state = panelStateFor(failed.proposal);
  assert.equal(state.kind, "failed");
  if (state.kind !== "failed") return;
  assert.equal(state.detail, REASON, "顯示的必須是這次的原因，字串完全相等");
  assert.match(state.title, /套用/, "作品可能已經被動過，訊息要說出來");
  assert.equal(state.retryOf, "apply", "要重試的是套用，不是重跑分析");

  // 不變式：risks 有幾條都不影響 —— 任何靠 index 取值的寫法都會在其中一種紅
  for (const risks of [[], ["一條"], ["一", "二", "三"]]) {
    const variant = transitionProposal(
      { ...applying.proposal, risks },
      "failed",
      { now, reason: REASON },
    );
    assert.ok(variant.ok);
    if (!variant.ok) continue;
    const s = panelStateFor(variant.proposal);
    assert.equal(
      s.kind === "failed" ? s.detail : "",
      REASON,
      `risks 長度 ${risks.length} 時取到了別的東西`,
    );
  }
});

test("診斷排序：嚴重的在前，同樣嚴重時量出來的在前", () => {
  const sorted = sortDiagnostics([
    diagnostic({ id: "nit", severity: "nit", measured: true }),
    diagnostic({ id: "model-major", severity: "major", measured: false, confidence: 0.9 }),
    diagnostic({ id: "measured-major", severity: "major", measured: true, confidence: 0.5 }),
    diagnostic({ id: "blocker", severity: "blocker", measured: false }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["blocker", "measured-major", "model-major", "nit"],
    "量出來的診斷比模型說的可靠，同級時要排前面",
  );
});

// ---------------------------------------------------------------------------
// 套用閘門
// ---------------------------------------------------------------------------

test("套用按鈕的預設是不能按，而且每一種都說得出理由", () => {
  const cases: Array<[string, DesignProposal, string | null, RegExp]> = [
    ["分析中", proposal({ status: "analyzing" }), "a-1", /還沒完成/],
    ["資料不足", proposal({ status: "needs-context" }), "a-1", /還沒完成/],
    ["已否決", proposal({ status: "rejected" }), "a-1", /否決/],
    ["已套用", proposal({ status: "applied" }), "a-1", /套用過/],
    ["套用中", proposal({ status: "applying" }), "a-1", /正在套用/],
    ["只有診斷沒有方案", proposal({ alternatives: [] }), null, /沒有可以套用的方案/],
    ["沒選方案", proposal(), null, /先選一個方案/],
    ["選到不存在的方案", proposal(), "不存在", /重新整理/],
  ];
  for (const [label, target, selected, expected] of cases) {
    const gate = applyGate(target, selected, true);
    assert.equal(gate.enabled, false, `${label} 不該可以套用`);
    if (!gate.enabled) {
      assert.match(gate.reason, expected, `${label} 的理由不夠具體：${gate.reason}`);
      assert.ok(gate.reason.length > 0, "灰色按鈕沒有說明，只會讓人以為系統壞了");
    }
  }
});

test("只有選了存在的方案、而且分析完成時才能套用", () => {
  assert.deepEqual(applyGate(proposal(), "a-1", true), { enabled: true });
  assert.deepEqual(applyGate(proposal({ status: "approved" }), "a-1", true), { enabled: true });
});

test("Canva／CUTOS／planform 沒有 ready adapter 就不能套用，不假裝成功", () => {
  const canva = proposal({
    patch: { adapter: "canva", payload: {}, reversible: false, revertHint: "無" },
  });
  const blocked = applyGate(canva, "a-1", true);
  assert.equal(blocked.enabled, false);
  if (!blocked.enabled) assert.match(blocked.reason, /整合尚未設定/);
  assert.equal(applyGate(canva, "a-1", true, { state: "unconfigured", missing: ["Canva 授權"] }).enabled, false);
  assert.equal(applyGate(canva, "a-1", true, { state: "contract-only", note: "無寫入端" }).enabled, false);
  assert.equal(applyGate(canva, "a-1", true, { state: "ready" }).enabled, true);
});

test("按下去之前就要說會改什麼、怎麼還原", () => {
  const target = proposal({ alternatives: [alternative("a-1", 3)] });
  const preview = applyPreviewText(target, "a-1");
  assert.equal(preview.changeCount, 3);
  assert.equal(preview.summary.length, 3);
  assert.match(preview.summary[0], /目標 0：改成值 0/, "要逐條列出，不是「將優化配色」");
  assert.match(preview.revertNote, /回到原稿/, "還原方式必須在按下去之前就說");

  // 有 patch 時用 patch 自己的還原說明
  const withPatch = proposal({
    alternatives: [alternative("a-1")],
    patch: { adapter: "board", payload: {}, reversible: true, revertHint: "回到 v3" },
  });
  assert.equal(applyPreviewText(withPatch, "a-1").revertNote, "回到 v3");

  // 沒選方案時不會編造內容
  assert.deepEqual(applyPreviewText(target, null), {
    changeCount: 0,
    summary: [],
    revertNote: "沒有選擇方案",
  });
});

// ===========================================================================
// 對抗審查（grok，PR-DI-04）後補的反例
// ===========================================================================

test("極矮的視窗下，收起的抽屜也不會蓋滿畫面", () => {
  // 軟鍵盤彈出、分割視窗、桌機瀏覽器被拉扁，都會出現很矮的視窗。
  // 固定 56px 的 peek 在 56px 高的視窗上就是 100%（對抗審查實測到的）。
  // 高於 ~270px：遵守 12% 上限
  for (const height of [300, 414, 800]) {
    const viewport = { width: 360, height, coarsePointer: true };
    const layout = layoutFor(viewport);
    const collapsed = occupiedRatio(layout, viewport, false);
    assert.ok(
      collapsed <= 0.13,
      `${height}px 高的視窗上，收起的抽屜佔了 ${Math.round(collapsed * 100)}%`,
    );
  }

  // 低於 ~270px：32px 的可點下限勝出，而且要**明確**是那個值 ——
  // 一個按不到的把手比一個稍微佔位的把手更糟。這是刻意的取捨，不是漏掉。
  for (const height of [56, 90, 160]) {
    const layout = layoutFor({ width: 360, height, coarsePointer: true });
    assert.equal(layout.kind, "sheet");
    if (layout.kind === "sheet") {
      assert.equal(layout.peekPx, 32, `${height}px 高時應該退回可點的下限`);
    }
  }

  // 而且無論多矮，peek 都不會超過原本的 56px
  for (const height of [56, 300, 800, 2000]) {
    const layout = layoutFor({ width: 360, height, coarsePointer: true });
    if (layout.kind === "sheet") assert.ok(layout.peekPx <= 56);
  }

  // 極端情況的**實際佔比**要被寫下來，不是只寫在註解裡：
  // 32px 高的視窗上，32px 的把手就是 100%。這個取捨的代價要看得見。
  const degenerate = { width: 360, height: 32, coarsePointer: true };
  const degenerateLayout = layoutFor(degenerate);
  assert.equal(
    occupiedRatio(degenerateLayout, degenerate, false),
    1,
    "32px 高的視窗上抽屜就是整個畫面 —— 這是已知且刻意的，寫成斷言讓它不會被忘記",
  );
});

test("橫放手機收起的抽屜也在上限內", () => {
  const landscape = { width: 896, height: 414, coarsePointer: true };
  const layout = layoutFor(landscape);
  assert.ok(occupiedRatio(layout, landscape, false) <= 0.13);
});

test("斜向的滑動不會吃掉垂直捲動，但大幅度的滑動仍然換頁", () => {
  // 49–57px 的垂直位移已經足夠捲一整條診斷。
  assert.equal(swipeIntent({ dx: -70, dy: 49, elapsedMs: 80 }), null);
  assert.equal(swipeIntent({ dx: -80, dy: 57, elapsedMs: 200 }), null);
  // 幾乎水平的仍然要換頁
  assert.equal(swipeIntent({ dx: -90, dy: 20, elapsedMs: 300 }), "next");
  assert.equal(swipeIntent({ dx: -70, dy: 30, elapsedMs: 200 }), "next");

  // **大幅度的斜向滑動是明確的意圖，不該被擋。**
  // 曾經加過「垂直位移不得超過 40px」的絕對上限，那會把下面這兩下擋掉 ——
  // 使用者橫向拉了 200px，那不是在捲清單。
  assert.equal(swipeIntent({ dx: -200, dy: 60, elapsedMs: 300 }), "next");
  assert.equal(swipeIntent({ dx: 300, dy: 80, elapsedMs: 400 }), "prev");

  // 比例是唯一的判準。邊界寫清楚：**未達兩倍才擋**，剛好兩倍就通過。
  assert.equal(swipeIntent({ dx: -99, dy: 50, elapsedMs: 300 }), null, "1.98 倍不夠");
  assert.equal(swipeIntent({ dx: -100, dy: 50, elapsedMs: 300 }), "next", "剛好 2 倍通過");
});

test("elapsedMs 為 0 或負數不會炸，也不會被當成無限快", () => {
  assert.equal(swipeIntent({ dx: -30, dy: 5, elapsedMs: 0 }), null, "沒有時間資訊就當慢速");
  assert.equal(swipeIntent({ dx: -30, dy: 5, elapsedMs: -100 }), null);
  assert.equal(swipeIntent({ dx: -90, dy: 5, elapsedMs: 0 }), "next", "位移夠大本來就該換");
});

test("已經處理過的提案不會顯示「沒有找到問題」", () => {
  // 使用者剛核准完，面板卻說「沒有找到可以量測的問題」是很怪的
  //（對抗審查實測到的）。
  const cases: Array<[DesignProposal["status"], RegExp]> = [
    ["approved", /已經核准/],
    ["applying", /正在套用/],
    ["applied", /已經套用完成/],
    ["rejected", /已經被否決/],
    ["reverted", /已經復原/],
  ];
  for (const [status, expected] of cases) {
    const state = panelStateFor(proposal({ status, diagnostics: [], alternatives: [] }));
    assert.equal(state.kind, "notice", `${status} 應該是 notice`);
    if (state.kind === "notice") {
      assert.match(state.title, expected, `${status} 的訊息不對：${state.title}`);
      assert.doesNotMatch(state.title, /沒有找到可以量測的問題/);
    }
  }
});

test("沒有修改權限的人不能套用，而且說得出原因", () => {
  const gate = applyGate(proposal(), "a-1", false);
  assert.equal(gate.enabled, false);
  if (!gate.enabled) assert.match(gate.reason, /沒有修改作品的權限/);

  // 有權限就照常
  assert.deepEqual(applyGate(proposal(), "a-1", true), { enabled: true });

  // 權限參數**沒有預設值**：忘了傳是型別錯誤，不是靜默放行。
  // 「預設 true」等於「忘了傳就全部放行」，那正是這個參數要防的事。
  //
  // 下面這行就是那條保證：如果哪天有人替它加回預設值，`@ts-expect-error`
  // 會變成「沒有錯誤可以期待」而讓 tsc 紅 —— 而 tsc 是 test:design-intelligence
  // 的第一段，所以這條紅線是 CI 擋得住的。
  // @ts-expect-error 第三個參數是必填的
  void applyGate(proposal(), "a-1");
});
