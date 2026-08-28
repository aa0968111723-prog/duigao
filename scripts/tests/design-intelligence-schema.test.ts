/**
 * PR-DI-00：契約層的可執行檢查。
 *
 * 這些測試存在的理由，是把任務書裡幾條「用眼睛看」的紅線變成「會紅」的斷言：
 * - AI 不得只講空話（診斷缺欄位就整條丟掉）
 * - 三個方向必須真的不同（strategy 不得重複）
 * - 搜尋結果不得自我升級成 approved
 * - 外部網址不得指向內網／metadata endpoint
 * - 沒有經過 approved 就不能 applied
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  canTransition,
  contentHashOf,
  contrastRatio,
  findKnowledgeConflicts,
  isSafePublicUrl,
  parseAlternatives,
  parseColorTokens,
  parseDiagnostics,
  parseKnowledgeEntry,
  parseResearchSources,
  parseHex,
  rankKnowledge,
  wcagLevel,
} from "../../src/features/design-intelligence/schema";
import {
  disabledResearchResult,
  isResearchDisabled,
  selectProvider,
  type Capability,
  type DesignAnalysisProvider,
} from "../../src/features/design-intelligence/providers";
import type { KnowledgeEntry } from "../../src/features/design-intelligence/types";

// ---- 色彩：對比是算出來的事實，不是模型說了算 ----------------------------

test("對比值由程式計算，且符合 WCAG 已知基準", () => {
  // 黑白是 21:1，這是規格定義的極值
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
  // 三位數縮寫要展開
  assert.deepEqual(parseHex("#fff"), { r: 255, g: 255, b: 255 });
  assert.equal(parseHex("not-a-color"), null);
  assert.equal(contrastRatio("#000000", "zzz"), null);
  assert.equal(wcagLevel(21), "AAA");
  assert.equal(wcagLevel(4.6), "AA");
  assert.equal(wcagLevel(3.2), "AA-large");
  assert.equal(wcagLevel(2), "none");
  assert.equal(wcagLevel(null), "n/a");
});

test("色票：角色不在詞彙表、hex 不合法、角色重複都要被擋下並說明原因", () => {
  const result = parseColorTokens([
    { role: "background", hex: "#ffffff" },
    { role: "text-primary", hex: "#767676" },
    { role: "text-primary", hex: "#000000" }, // 重複
    { role: "vibe", hex: "#123456" }, // 不在詞彙表
    { role: "danger", hex: "紅色" }, // 不是 hex
  ]);
  assert.equal(result.value.length, 2, "只留下 background 與第一個 text-primary");
  assert.ok(result.rejected.some((line) => line.includes("角色不在詞彙表")));
  assert.ok(result.rejected.some((line) => line.includes("出現兩次")));
  assert.ok(result.rejected.some((line) => line.includes("hex 不合法")));
  const textToken = result.value.find((token) => token.role === "text-primary")!;
  assert.equal(textToken.contrastAgainst, "background");
  assert.ok(textToken.contrastRatio! > 4 && textToken.contrastRatio! < 5, `#767676 on white ≈ 4.54（實得 ${textToken.contrastRatio}）`);
  assert.equal(textToken.wcag, "AA");
});

test("色票：沒有背景色時不假裝算得出對比", () => {
  const result = parseColorTokens([{ role: "text-primary", hex: "#000000" }]);
  assert.equal(result.value[0].contrastRatio, null);
  assert.equal(result.value[0].wcag, "n/a", "算不出來就說 n/a，不要瞎報一個數字");
});

// ---- 診斷：禁止空話 -------------------------------------------------------

test("診斷缺少任何一個必要欄位就整條丟掉，並說明缺哪一欄", () => {
  const result = parseDiagnostics([
    {
      location: "主標題區",
      issue: "標題與日期字級相同",
      impact: "掃視時抓不到活動名稱，手機縮圖尤其明顯",
      evidence: "兩者皆為 28px／字重 700",
      recommendation: "標題升到 40px／字重 800，日期降到 20px／字重 500",
      severity: "major",
      confidence: 0.82,
    },
    // 這是任務書第十三節明文禁止的那種回答
    { location: "整體", issue: "配色可以更好", impact: "", evidence: "", recommendation: "建議調整配色" },
  ]);
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].severity, "major");
  assert.ok(
    result.rejected.some((line) => line.includes("impact") && line.includes("evidence")),
    `應說明缺了哪幾欄，實得：${result.rejected.join(" / ")}`,
  );
});

test("信心值：百分比與超界值都夾回 0–1，不是丟掉", () => {
  const base = {
    location: "a", issue: "b", impact: "c", evidence: "d", recommendation: "e",
  };
  const result = parseDiagnostics([
    { ...base, confidence: 85 },
    { ...base, confidence: -3 },
    { ...base, confidence: "高" },
  ]);
  assert.equal(result.value[0].confidence, 0.85);
  assert.equal(result.value[1].confidence, 0);
  assert.equal(result.value[2].confidence, 0.5, "無法解讀時取中間值，不假裝很有信心");
});

// ---- 方案：三個方向必須真的不同 -------------------------------------------

test("方案：strategy 重複要被擋（不能只是三組不同顏色）", () => {
  const change = { target: "標題", change: "40px", reason: "建立層級" };
  const result = parseAlternatives([
    { name: "微調", strategy: "conservative", changes: [change] },
    { name: "再微調", strategy: "conservative", changes: [change] },
    { name: "重排", strategy: "balanced", changes: [change] },
  ]);
  assert.deepEqual(result.value.map((alt) => alt.strategy), ["conservative", "balanced"]);
  assert.ok(result.rejected.some((line) => line.includes("三個方向必須真的不同")));
});

test("方案：沒有任何具體修改的方案要被擋", () => {
  const result = parseAlternatives([
    { name: "更專業", strategy: "bold", changes: [], advantages: ["看起來更好"] },
  ]);
  assert.equal(result.value.length, 0);
  assert.ok(result.rejected.some((line) => line.includes("只有形容詞")));
});

// ---- 外部來源：SSRF 與內網探測在型別邊界就擋 -----------------------------

test("外部網址：只接受 https 的公開位址", () => {
  assert.equal(isSafePublicUrl("https://www.w3.org/TR/WCAG22/"), true);
  assert.equal(isSafePublicUrl("http://www.w3.org/"), false, "http 不接受");
  assert.equal(isSafePublicUrl("file:///etc/passwd"), false);
  assert.equal(isSafePublicUrl("https://localhost/admin"), false);
  assert.equal(isSafePublicUrl("https://127.0.0.1/"), false);
  assert.equal(isSafePublicUrl("https://10.1.2.3/"), false);
  assert.equal(isSafePublicUrl("https://192.168.0.1/"), false);
  assert.equal(isSafePublicUrl("https://172.16.5.4/"), false);
  assert.equal(isSafePublicUrl("https://169.254.169.254/latest/meta-data/"), false, "雲端 metadata endpoint");
  assert.equal(isSafePublicUrl("https://metadata.google.internal/"), false);
  assert.equal(isSafePublicUrl("不是網址"), false);
});

test("外部來源：不安全網址被丟棄、重複去除、發布日期缺失不得用取得時間冒充", () => {
  const result = parseResearchSources([
    { url: "https://developer.mozilla.org/a", title: "MDN", sourceType: "vendor-doc", retrievedAt: 1000 },
    { url: "https://developer.mozilla.org/a", title: "重複" },
    { url: "https://169.254.169.254/", title: "壞的" },
  ]);
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].publishedAt, null, "頁面沒標日期就是 null");
  assert.equal(result.value[0].retrievedAt, 1000);
  assert.ok(result.rejected.some((line) => line.includes("不安全")));
});

// ---- 知識：信任等級不得自我升級 -------------------------------------------

test("機器研究的結果不得自稱 approved／project", () => {
  const result = parseKnowledgeEntry({
    category: "accessibility",
    title: "內文對比至少 4.5:1",
    summary: "WCAG 2.2 AA 對一般大小文字要求 4.5:1。",
    rules: ["內文與背景對比 ≥ 4.5:1"],
    status: "machine-researched",
    trustLevel: "approved", // ← 想自己升級
    sourceUrl: "https://www.w3.org/TR/WCAG22/",
  });
  assert.ok(result.ok);
  assert.equal(result.value!.trustLevel, "machine", "搜尋結果不能直接變成已核准知識");
  assert.ok(result.rejected.some((line) => line.includes("不得自稱")));
});

test("知識條目：沒有可執行規則就不是知識", () => {
  const result = parseKnowledgeEntry({
    category: "color", title: "色彩很重要", summary: "色彩會影響感受。", rules: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.rejected.some((line) => line.includes("沒有任何可執行規則")));
});

test("知識條目：不安全的來源網址被移除但條目本身保留", () => {
  const result = parseKnowledgeEntry({
    category: "layout", title: "t", summary: "s", rules: ["r"],
    sourceUrl: "https://127.0.0.1/internal",
  });
  assert.ok(result.ok);
  assert.equal(result.value!.sourceUrl, null);
  assert.ok(result.rejected.some((line) => line.includes("來源網址不安全")));
});

const knowledge = (over: Partial<KnowledgeEntry>): KnowledgeEntry => ({
  id: over.id ?? "k",
  category: "typography",
  title: "t",
  summary: "s",
  rules: ["r"],
  exceptions: [],
  applicableContexts: ["poster"],
  sourceUrl: null,
  sourceTitle: null,
  sourceType: "unknown",
  publisher: null,
  retrievedAt: null,
  reviewedAt: null,
  version: 1,
  trustLevel: "machine",
  projectSpecific: null,
  status: "machine-researched",
  contentHash: "aaaa",
  ...over,
});

test("知識排序：專案規範 > 已核准 > 已審 > 機器 > 未驗證；deprecated 不出現", () => {
  const ranked = rankKnowledge([
    knowledge({ id: "machine", trustLevel: "machine" }),
    knowledge({ id: "project", trustLevel: "project", projectSpecific: "duigao" }),
    knowledge({ id: "old", trustLevel: "approved", status: "deprecated" }),
    knowledge({ id: "approved", trustLevel: "approved", status: "approved" }),
  ]);
  assert.deepEqual(ranked.map((entry) => entry.id), ["project", "approved", "machine"]);
});

test("衝突不自行消除，只標示出來", () => {
  const conflicts = findKnowledgeConflicts([
    knowledge({ id: "a", contentHash: "aaa", applicableContexts: ["mobile"] }),
    knowledge({ id: "b", contentHash: "bbb", applicableContexts: ["mobile"] }),
    knowledge({ id: "c", contentHash: "aaa", applicableContexts: ["print"] }),
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].context, "mobile");
  assert.deepEqual(conflicts[0].entryIds.sort(), ["a", "b"]);
});

test("內容雜湊：同內容同雜湊、改一個字就不同", () => {
  const a = contentHashOf("標題", "摘要", ["規則一"]);
  assert.equal(a, contentHashOf("標題", "摘要", ["規則一"]));
  assert.notEqual(a, contentHashOf("標題", "摘要", ["規則二"]));
});

// ---- 狀態機：沒經過人確認就不能套用 ---------------------------------------

test("提案狀態機：analyzing 不能直接跳到 applied", () => {
  assert.equal(canTransition("draft", "analyzing"), true);
  assert.equal(canTransition("ready", "approved"), true);
  assert.equal(canTransition("approved", "applying"), true);
  assert.equal(canTransition("applying", "applied"), true);
  assert.equal(canTransition("applied", "reverted"), true);
  // 紅線：AI 不得自動執行
  assert.equal(canTransition("analyzing", "applied"), false);
  assert.equal(canTransition("ready", "applied"), false, "必須先 approved");
  assert.equal(canTransition("rejected", "applied"), false);
  assert.equal(canTransition("reverted", "applied"), false);
});

// ---- Provider 選擇：能力不足要誠實說 --------------------------------------

const fakeProvider = (
  id: string,
  caps: Capability[],
  ready = true,
): DesignAnalysisProvider => ({
  id,
  capabilities: () => caps,
  status: async () => (ready ? { state: "ready" } : { state: "unconfigured", missing: ["KEY"] }),
  analyze: async () => ({ provider: id, model: null, raw: {}, satisfied: caps, gaps: [], usage: { inputTokens: null, outputTokens: null } }),
});

test("provider 選擇：挑覆蓋最多能力者，並列出缺口", async () => {
  const { provider, gaps } = await selectProvider(
    [fakeProvider("text-only", ["text-analysis"]), fakeProvider("full", ["text-analysis", "vision-analysis"])],
    ["text-analysis", "vision-analysis"],
  );
  assert.equal(provider?.id, "full");
  assert.equal(gaps.length, 0);
});

test("provider 選擇：能力不足時不假裝分析過圖片，且說得出還能做什麼", async () => {
  const { provider, gaps } = await selectProvider(
    [fakeProvider("text-only", ["text-analysis"])],
    ["text-analysis", "vision-analysis"],
  );
  assert.equal(provider?.id, "text-only");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].missing, "vision-analysis");
  assert.ok(gaps[0].cannotDo.includes("看圖片"), gaps[0].cannotDo);
  assert.ok(gaps[0].workaround.length > 0);
  assert.ok(gaps[0].stillAvailable.length > 0, "不阻塞文字協作");
});

test("provider 選擇：全部未設定時回 null 而不是丟例外", async () => {
  const { provider, gaps } = await selectProvider(
    [fakeProvider("nope", ["text-analysis"], false)],
    ["text-analysis"],
  );
  assert.equal(provider, null);
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0].stillAvailable.some((item) => item.includes("討論")), "AI 掛掉不得影響討論");
});

// ---- 研究服務未設定 -------------------------------------------------------

test("研究服務未設定：可分辨「沒設定」與「查不到」，且不是空答案冒充", () => {
  const result = disabledResearchResult("最新的 WCAG 對比要求", "PERPLEXITY_API_KEY 未設定");
  assert.equal(isResearchDisabled(result), true);
  assert.equal(result.provider, "none");
  assert.equal(result.answer, "", "沒設定時不得生成任何答案文字");
  assert.equal(result.sources.length, 0);
  assert.equal(result.usage.requests, 0, "沒有實際請求就不能記使用量");
  assert.equal(result.cacheStatus, "bypass");
});
