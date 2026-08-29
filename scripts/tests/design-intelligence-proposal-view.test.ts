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
    const ratio = occupiedRatio(layout, viewport);
    assert.ok(
      ratio <= 0.8,
      `${label}：AI 面板佔了 ${Math.round(ratio * 100)}% 的畫面，主畫面被吃掉了`,
    );
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
    proposal({ status: "failed", risks: ["AI 分析沒有完成（503 上游無回應）"] }),
  );
  assert.equal(failed.kind, "failed");
  if (failed.kind === "failed") {
    assert.match(failed.detail, /503/, "失敗原因要照實顯示，不能用「請稍後再試」蓋掉");
    assert.equal(failed.retryable, true);
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
    const gate = applyGate(target, selected);
    assert.equal(gate.enabled, false, `${label} 不該可以套用`);
    if (!gate.enabled) {
      assert.match(gate.reason, expected, `${label} 的理由不夠具體：${gate.reason}`);
      assert.ok(gate.reason.length > 0, "灰色按鈕沒有說明，只會讓人以為系統壞了");
    }
  }
});

test("只有選了存在的方案、而且分析完成時才能套用", () => {
  assert.deepEqual(applyGate(proposal(), "a-1"), { enabled: true });
  assert.deepEqual(applyGate(proposal({ status: "approved" }), "a-1"), { enabled: true });
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
