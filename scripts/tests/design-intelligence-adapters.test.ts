/**
 * 外部工具契約的整合測試（PR-DI-05）。
 *
 * 這一組驗的是三件事：
 *   1. **沒有任何 adapter 能繞過人類確認。** 產生 patch 不等於套用，
 *      而套用只有 `lifecycle.transitionProposal` 一條路。
 *   2. **沒有 adapter 假裝已連線。** 沒設定就說沒設定。
 *   3. **模型的自由文字不會變成可執行的東西。**
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  adaptersFor,
  createCanvaAdapter,
  cutosAdapter,
  fileContextAdapter,
  planformIsoAdapter,
  websitePatchAdapter,
  whiteboardAdapter,
  type DesignTargetAdapter,
} from "../../src/features/design-intelligence/adapters";
import { transitionProposal } from "../../src/features/design-intelligence/lifecycle";
import type {
  ColorToken,
  DesignAlternative,
  DesignProposal,
  DesignTargetType,
} from "../../src/features/design-intelligence/types";

function token(role: ColorToken["role"], hex: string, cssToken: string): ColorToken {
  return { role, hex, rgb: { r: 0, g: 0, b: 0 }, cssToken, contrastRatio: null, wcag: "none" };
}

function alternative(over: Partial<DesignAlternative> = {}): DesignAlternative {
  return {
    id: "alt-1",
    name: "方案",
    strategy: "conservative",
    changes: [
      { dimension: "color", target: "內文顏色", change: "#aaaaaa → #767676", reason: "量測 2.32:1" },
      { dimension: "layout", target: "上方留白", change: "24px → 64px", reason: "形成呼吸感" },
    ],
    designTokens: [],
    preview: null,
    advantages: [],
    tradeoffs: [],
    ...over,
  };
}

function proposal(over: Partial<DesignProposal> = {}): DesignProposal {
  return {
    id: "p-1",
    roomId: "room-1",
    projectId: "room-1",
    artifactId: null,
    targetType: "board",
    targetId: "board-1",
    mode: "improve",
    goal: "目標",
    contextSummary: "摘要",
    diagnostics: [],
    alternatives: [alternative()],
    recommendedAlternativeId: "alt-1",
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

const ALL: DesignTargetAdapter[] = [
  whiteboardAdapter,
  createCanvaAdapter({ isConnected: async () => false }),
  cutosAdapter,
  planformIsoAdapter,
  websitePatchAdapter,
  fileContextAdapter,
];

// ---------------------------------------------------------------------------
// 紅線：產生 patch 不等於套用
// ---------------------------------------------------------------------------

test("產生 patch 不會改動提案的狀態，也不會設定 appliedAt", () => {
  const target = proposal();
  const before = JSON.stringify(target);
  const result = whiteboardAdapter.buildPatch(target, "alt-1");
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(target), before, "buildPatch 不得改動傳進來的提案");
});

test("有了 patch 之後，仍然要經過核准才能套用", () => {
  const built = whiteboardAdapter.buildPatch(proposal(), "alt-1");
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const withPatch = proposal({ patch: built.patch });
  // 直接跳 applying：狀態機擋下
  const direct = transitionProposal(withPatch, "applying", { now: () => 1, baseRevision: "v1" });
  assert.equal(direct.ok, false);

  // 就算狀態被硬設成 approved，沒有 approvedBy 一樣擋下
  const faked = proposal({ patch: built.patch, status: "approved" });
  const sneaky = transitionProposal(faked, "applying", { now: () => 1, baseRevision: "v1" });
  assert.equal(sneaky.ok, false);
  assert.match(sneaky.ok ? "" : sneaky.reason, /還沒有人核准/);
});

test("已經結束的提案不能再產生套用計畫", () => {
  for (const status of ["applied", "rejected", "reverted"] as const) {
    const result = whiteboardAdapter.buildPatch(proposal({ status }), "alt-1");
    assert.equal(result.ok, false, `${status} 不該還能產生 patch`);
    if (!result.ok) assert.match(result.reason, new RegExp(status));
  }
});

test("分析還沒完成的提案不能產生套用計畫", () => {
  for (const status of ["draft", "analyzing", "needs-context", "failed"] as const) {
    const result = whiteboardAdapter.buildPatch(proposal({ status }), "alt-1");
    assert.equal(result.ok, false, `${status} 不該能產生 patch`);
  }
});

// ---------------------------------------------------------------------------
// 紅線：不假裝已連線
// ---------------------------------------------------------------------------

test("沒有連上 Canva 就說沒連上，不假裝", async () => {
  const disconnected = createCanvaAdapter({ isConnected: async () => false });
  const status = await disconnected.status();
  assert.equal(status.state, "unconfigured");
  if (status.state === "unconfigured") {
    assert.deepEqual(status.missing, ["Canva 授權"]);
  }

  const connected = createCanvaAdapter({ isConnected: async () => true });
  const okStatus = await connected.status();
  // 連上了也不代表「可以自動套用」—— 那部分屬別條工作線，誠實標成契約層
  assert.equal(okStatus.state, "contract-only");
});

test("只有契約沒有實作的 adapter 明說自己是契約層", async () => {
  for (const adapter of [cutosAdapter, planformIsoAdapter]) {
    const status = await adapter.status();
    assert.equal(status.state, "contract-only", `${adapter.label} 不該宣稱 ready`);
    if (status.state === "contract-only") {
      assert.ok(status.note.length > 10, "要說清楚為什麼只有契約");
    }
  }
});

test("沒有實作自動套用的 adapter，patch 一律標成不可逆 —— 因此 lifecycle 會拒絕它", () => {
  const cases: Array<[DesignTargetAdapter, DesignTargetType]> = [
    [createCanvaAdapter({ isConnected: async () => true }), "poster"],
    [cutosAdapter, "video"],
    [planformIsoAdapter, "plan"],
    // 網站也在這一組：它產得出 CSS 變數差異，但沒有寫入端，
    // 也沒有記錄原值 —— 「改回原值」沒有原值可改。
    [websitePatchAdapter, "website"],
  ];
  const withTokens = alternative({
    designTokens: [token("text-primary", "#767676", "--di-text")],
  });
  for (const [adapter, targetType] of cases) {
    const built = adapter.buildPatch(
      proposal({ targetType, alternatives: [withTokens] }),
      "alt-1",
    );
    assert.equal(built.ok, true, `${adapter.label} 應該產得出 payload`);
    if (!built.ok) continue;
    assert.equal(built.patch.reversible, false, `${adapter.label} 沒有還原機制卻標成可逆`);
    assert.ok(built.warnings.length > 0, `${adapter.label} 應該警告使用者這份 payload 的限制`);

    // 這件事的實際後果：lifecycle 會拒絕自動套用
    const approved = proposal({
      targetType,
      patch: built.patch,
      status: "approved",
      approvedBy: "user-2",
      approvedAt: 1,
    });
    const result = transitionProposal(approved, "applying", { now: () => 1, baseRevision: "v1" });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /不可逆/);
  }
});

// ---------------------------------------------------------------------------
// 白板：轉譯而不擴充白名單
// ---------------------------------------------------------------------------

test("白板走既有的 add_whiteboard_node，不新增動作型別", () => {
  const built = whiteboardAdapter.buildPatch(proposal(), "alt-1");
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const nodes = built.patch.payload.nodes as Array<Record<string, unknown>>;
  assert.equal(nodes.length, 2);
  for (const node of nodes) {
    assert.equal(
      node.action,
      "add_whiteboard_node",
      "新增動作型別會逼三個地方一起改，其中一個在不該碰的 edge function 裡",
    );
  }
  // 便利貼上留下的是「要做什麼」，不是 AI 的敘述
  assert.equal(nodes[0].text, "內文顏色：#aaaaaa → #767676");
  assert.equal(built.patch.reversible, true);
  assert.match(built.patch.revertHint, /刪除.*2 張便利貼/);
});

test("白板改動太多時警告會擠", () => {
  const many = alternative({
    changes: Array.from({ length: 12 }, (_, index) => ({
      dimension: "color" as const,
      target: `目標 ${index}`,
      change: `改成 ${index}`,
      reason: "理由",
    })),
  });
  const built = whiteboardAdapter.buildPatch(proposal({ alternatives: [many] }), "alt-1");
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.ok(built.warnings.some((warning) => warning.includes("很擠")));
});

// ---------------------------------------------------------------------------
// 網站：模型的自由文字不會變成可執行的樣式
// ---------------------------------------------------------------------------

test("網站樣式只接受結構化的色票，不從自由文字解析 CSS", () => {
  const withTokens = alternative({
    designTokens: [
      token("text-primary", "#767676", "--di-text-primary"),
      token("surface", "#ffffff", "--di-surface"),
    ],
  });
  const built = websitePatchAdapter.buildPatch(
    proposal({ targetType: "website", alternatives: [withTokens] }),
    "alt-1",
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.patch.payload.variables, {
    "--di-text-primary": "#767676",
    "--di-surface": "#ffffff",
  });
  // **不可逆**：payload 沒有記錄原本的變數值，所以「改回原值」是一句空話。
  assert.equal(built.patch.reversible, false);
  assert.ok(built.warnings.some((warning) => warning.includes("無法自動還原")));

  // 自由文字裡的 CSS 完全不會出現在 payload 裡
  const serialized = JSON.stringify(built.patch.payload);
  assert.ok(!serialized.includes("display"), "自由文字不該被解析成 CSS");
});

test("不合法的 CSS 變數名稱與色值被擋下", () => {
  const evil = alternative({
    designTokens: [
      token("text-primary", "#767676", "body { display: none } --x"),
      token("surface", "url(javascript:alert(1))", "--di-surface"),
      token("accent", "#6157ef", "--di-accent"),
    ],
  });
  const built = websitePatchAdapter.buildPatch(
    proposal({ targetType: "website", alternatives: [evil] }),
    "alt-1",
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(
    Object.keys(built.patch.payload.variables as Record<string, string>),
    ["--di-accent"],
    "只有合法的那一個該留下",
  );
  assert.equal(built.warnings.length, 3, "兩個被丟掉的色票，加上不可逆的警告");
  const serialized = JSON.stringify(built.patch.payload);
  assert.ok(!serialized.includes("javascript:"));
  assert.ok(!serialized.includes("display: none"));
});

test("沒有色票時網站 adapter 誠實失敗，不產生空 patch", () => {
  const built = websitePatchAdapter.buildPatch(proposal({ targetType: "website" }), "alt-1");
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.reason, /沒有產生任何 design token/);
});

// ---------------------------------------------------------------------------
// CUTOS：不編造沒讀過的東西
// ---------------------------------------------------------------------------

test("沒有讀過影片就不編造鏡頭秒數", () => {
  const built = cutosAdapter.buildPatch(proposal({ targetType: "video" }), "alt-1");
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const shots = built.patch.payload.shots as Array<Record<string, unknown>>;
  for (const shot of shots) {
    assert.equal(shot.durationSec, null, "編一個秒數出來就是幻覺");
  }
  assert.equal(built.patch.payload.requiresApproval, true, "CUTOS 的 export 需要人工核准");
  assert.ok(built.warnings.some((warning) => warning.includes("秒數")));
});

// ---------------------------------------------------------------------------
// 唯讀與選擇
// ---------------------------------------------------------------------------

test("檔案脈絡是唯讀的，buildPatch 永遠失敗", () => {
  const built = fileContextAdapter.buildPatch(proposal(), "alt-1");
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.reason, /唯讀/);
});

test("依作品類型挑出可用的 adapter，唯讀的不算", () => {
  assert.deepEqual(
    adaptersFor(proposal({ targetType: "board" }), ALL).map((adapter) => adapter.id),
    ["board"],
  );
  assert.deepEqual(
    adaptersFor(proposal({ targetType: "poster" }), ALL).map((adapter) => adapter.id),
    ["canva"],
  );
  assert.deepEqual(
    adaptersFor(proposal({ targetType: "video" }), ALL).map((adapter) => adapter.id),
    ["cutos"],
  );
  assert.deepEqual(
    adaptersFor(proposal({ targetType: "website" }), ALL).map((adapter) => adapter.id),
    ["website"],
  );
  // plan 同時被白板與 planform-iso 接受 —— 讓人選
  assert.deepEqual(
    adaptersFor(proposal({ targetType: "plan" }), ALL).map((adapter) => adapter.id).sort(),
    ["board", "planform-iso"],
  );
});

test("找不到方案或方案沒有改動時，每個 adapter 都誠實失敗", () => {
  const empty = alternative({ changes: [] });
  for (const adapter of ALL) {
    if (adapter.id === "none") continue;
    const missing = adapter.buildPatch(proposal(), "不存在的方案");
    assert.equal(missing.ok, false, `${adapter.label} 對不存在的方案應該失敗`);

    const noChanges = adapter.buildPatch(proposal({ alternatives: [empty] }), "alt-1");
    assert.equal(noChanges.ok, false, `${adapter.label} 對沒有改動的方案應該失敗`);
  }
});

test("色值用 hex 的規則驗，不是寬鬆的字元類", () => {
  // 自己探測時發現的：舊的字元類讓 var()、expression()、calc() 全部通過。
  // 這些在正常流程裡進不來（值來自 parseColorTokens），但這一層不能假設
  // 呼叫端一定走過那條路 —— 「上游驗過了」是最常見的破口說法。
  const sneaky = alternative({
    designTokens: [
      // 對抗審查列出的那一整組：它們全都通過舊的寬鬆字元類。
      // `url(javascript:...)` 之前被擋只是因為冒號剛好不在字元表裡 ——
      // 測試打在一個碰巧會失敗的例子上，那不算守住。
      token("text-primary", "var(--evil)", "--a"),
      token("surface", "expression(alert(1))", "--b"),
      token("accent", "calc(100% - 1px)", "--c"),
      token("text-secondary", "url(//evil.com)", "--f"),
      token("primary-action", "attr(href)", "--g"),
      token("success", "red", "--h"),
      token("border", "#767676", "--d"),
      token("background", "#fff", "--e"),
    ],
  });
  const built = websitePatchAdapter.buildPatch(
    proposal({ targetType: "website", alternatives: [sneaky] }),
    "alt-1",
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(
    built.patch.payload.variables,
    { "--d": "#767676", "--e": "#fff" },
    "只有真的 hex 該留下",
  );
  assert.equal(built.warnings.length, 7, "六個被丟掉的色票，加上不可逆的警告");
});
