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
  const change = { dimension: "typography", target: "標題", change: "40px", reason: "建立層級" };
  const result = parseAlternatives([
    { name: "微調", strategy: "conservative", changes: [change] },
    { name: "再微調", strategy: "conservative", changes: [change] },
    { name: "重排", strategy: "balanced", changes: [change] },
  ]);
  assert.deepEqual(result.value.map((alt) => alt.strategy), ["conservative", "balanced"]);
  assert.ok(result.rejected.some((line) => line.includes("三個方向必須真的不同")));
});

test("方案：沒有標明維度的改動要被退掉", () => {
  // dimension 是「三個方案真的不同」唯一可檢查的依據。讓它可選，
  // 等於讓那條規則失效 —— 模型只要不填就繞過了。
  const result = parseAlternatives([
    {
      name: "微調",
      strategy: "conservative",
      changes: [
        { target: "標題", change: "40px", reason: "建立層級" },              // 缺 dimension
        { dimension: "不存在的維度", target: "副標", change: "18px", reason: "拉開" },
        { dimension: "typography", target: "內文", change: "16px", reason: "可讀性" },
      ],
    },
  ]);
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].changes.length, 1, "只有標明合法維度的那一條該留下");
  assert.equal(result.value[0].changes[0].target, "內文");
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

// ===========================================================================
// 對抗審查（grok，PR-DI-00）後補的反例
//
// 每一條都對應一個「拿掉實作、原本 20 條測試仍全綠」的假綠。測試的價值在於
// 拿掉實作會紅，不在於數量 —— 這一組是為了讓上面那句話對每條紅線都成立。
// ===========================================================================

test("SSRF：等價寫法的內網與 metadata 網址一樣要擋", () => {
  // 逐一列舉網段擋不住的那些寫法：IPv4-mapped IPv6、URL parser 的數值正規化、
  // DNS 尾點、單標籤主機名。
  for (const evil of [
    "https://[::ffff:169.254.169.254]/",   // IPv4-mapped IPv6 → metadata
    "https://[::ffff:127.0.0.1]/",
    "https://metadata.google.internal./",   // 尾點在 DNS 上等價
    "https://localhost./",
    "https://intranet.local./",
    "https://0.0.0.0/",
    "https://0/",                            // parser 正規化成 0.0.0.0
    "https://[::]/",
    "https://[fe80::1]/",                   // link-local
    "https://[fd00::1]/",                   // unique local
    "https://192.0.2.1/",                   // 任何裸 IP 都不是合法引用來源
    "https://8.8.8.8/",
    "https://intranet/",                    // 單標籤 → 只可能是內網
    "https://metadata/",
    // 把 IP 編進主機名的萬用 DNS：字串上完全不是 IP 字面值，
    // 但會解析回內網位址（對抗審查實測到的）。
    "https://169.254.169.254.nip.io/latest/meta-data/",
    "https://127.0.0.1.nip.io/",
    "https://10.0.0.1.sslip.io/",
    "https://192-168-1-1.sslip.io/",
    "https://127.0.0.1.localtest.me/",
    "https://anything.lvh.me/",
  ]) {
    assert.equal(isSafePublicUrl(evil), false, `應該擋下：${evil}`);
  }
  // 正常的公開網址不能被誤殺
  for (const good of [
    "https://www.w3.org/TR/WCAG22/",
    "https://developer.mozilla.org/en-US/docs/Web/CSS",
    "https://example.co.uk/a?b=c#d",
    // 正常網域裡出現數字不該被誤殺
    "https://www.w3.org/TR/WCAG22/#contrast-minimum",
    "https://web.dev/articles/color-and-contrast-accessibility",
  ]) {
    assert.equal(isSafePublicUrl(good), true, `不該擋下：${good}`);
  }
});

test("信任等級由來源決定，payload 自稱沒有用", () => {
  const payload = {
    category: "color",
    title: "搜來的配色規則",
    summary: "摘要",
    rules: ["規則一"],
    status: "approved",       // ← 不可信輸入自己宣稱已核准
    trustLevel: "approved",
  };
  const machine = parseKnowledgeEntry(payload, "machine");
  assert.equal(machine.ok, true);
  assert.equal(machine.value?.trustLevel, "machine", "機器來源的上限就是 machine");
  assert.equal(machine.value?.status, "machine-researched", "機器來源不得自稱 approved 狀態");
  assert.ok(machine.rejected.length >= 1, "降級必須留下記錄，不能悄悄改掉");

  // 省略 status（預設 draft）也不能藉此拿到 approved
  const sneaky = parseKnowledgeEntry(
    { category: "color", title: "t", summary: "s", rules: ["r"], trustLevel: "project" },
    "machine",
  );
  assert.equal(sneaky.value?.trustLevel, "machine");

  // 預設參數必須是最嚴格的那一檔（呼叫端忘了傳 → 不是最寬鬆）
  const forgotten = parseKnowledgeEntry({ ...payload });
  assert.equal(forgotten.value?.trustLevel, "machine");

  // 人工審查路徑才拿得到 approved；專案規範才拿得到 project
  assert.equal(parseKnowledgeEntry(payload, "human-review").value?.trustLevel, "approved");
  assert.equal(
    parseKnowledgeEntry({ ...payload, trustLevel: "project" }, "project").value?.trustLevel,
    "project",
  );
  // 但人工審查也不能升到 project
  assert.equal(
    parseKnowledgeEntry({ ...payload, trustLevel: "project" }, "human-review").value?.trustLevel,
    "approved",
  );
});

test("色彩對比取最差的底色，不是只對 background", () => {
  // 反例：對 background(#000) 是 9.04（AAA），但這個字實際落在 surface(#fff)
  // 上時只有 2.32（不及格）。只看 background 會把不及格報成 AAA。
  const result = parseColorTokens([
    { role: "background", hex: "#000000" },
    { role: "surface", hex: "#ffffff" },
    { role: "text-primary", hex: "#aaaaaa" },
  ]);
  const textToken = result.value.find((token) => token.role === "text-primary");
  assert.ok(textToken);
  assert.equal(textToken.contrastAgainst, "surface", "要回報是對哪個底色算的");
  assert.ok(
    textToken.contrastRatio !== null && textToken.contrastRatio < 2.4,
    `應取最差值 2.32，實得 ${textToken.contrastRatio}`,
  );
  assert.equal(textToken.wcag, "none", "2.32 不該被標成任何通過等級");
});

test("模型自己給的 contrastRatio 不被採信", () => {
  const result = parseColorTokens([
    { role: "background", hex: "#ffffff" },
    { role: "text-primary", hex: "#cccccc", contrastRatio: 21, wcag: "AAA" },
  ]);
  const textToken = result.value.find((token) => token.role === "text-primary");
  assert.ok(textToken);
  assert.ok(textToken.contrastRatio !== null && textToken.contrastRatio < 2, "對比必須自己算");
  assert.equal(textToken.wcag, "none");
});

test("診斷缺任何一個必填欄位都要退：逐欄反例", () => {
  const complete = {
    location: "海報上緣標題",
    issue: "標題與底圖對比 2.1:1",
    impact: "在手機縮圖尺寸下讀不到標題",
    evidence: "量測值 2.1:1，低於 WCAG AA 的 4.5:1",
    recommendation: "標題改為 #1a1a1a 或在底圖上加 60% 暗色遮罩",
    severity: "high",
    confidence: 0.9,
  };
  // 完整的要收
  assert.equal(parseDiagnostics([complete]).value.length, 1);
  // 每一個必填欄位單獨拿掉都要退 —— 舊測試的壞樣本一次缺兩欄，
  // 只證明了「缺 impact 或 evidence 會退」，location/recommendation 是假綠。
  for (const field of ["location", "issue", "impact", "evidence", "recommendation"]) {
    const broken = { ...complete, [field]: "" };
    const result = parseDiagnostics([broken]);
    assert.equal(result.value.length, 0, `缺 ${field} 仍被收下`);
    assert.ok(result.rejected.length >= 1, `缺 ${field} 沒有留下退件理由`);
  }
});

test("「沒設定」與「查了但沒結果」必須分得出來", () => {
  const disabled = disabledResearchResult("問題", "沒有金鑰");
  assert.equal(isResearchDisabled(disabled), true);

  // 真的查過但零結果 —— 這不是「沒設定」，UI 要顯示的訊息完全不同
  const emptyButReal = {
    ...disabled,
    provider: "perplexity",
    requestId: "req-1",
    retrievedAt: 1,
    usage: { inputTokens: 10, outputTokens: 5, requests: 1 },
    cacheStatus: "miss" as const,
  };
  assert.equal(
    isResearchDisabled(emptyButReal),
    false,
    "查了沒結果被當成沒設定，使用者會以為是設定問題而去改設定",
  );
});

test("狀態機：任何路徑都不能跳過人類確認直接 applied", () => {
  // 舊測試只擋了 analyzing/ready → applied，沒擋 → applying，
  // 於是「加一條 analyzing → applying」就能繞過核准而測試仍全綠。
  for (const from of ["draft", "analyzing", "needs-context", "ready", "failed"]) {
    assert.equal(canTransition(from, "applying"), false, `${from} → applying 不該成立`);
    assert.equal(canTransition(from, "applied"), false, `${from} → applied 不該成立`);
  }
  // 唯一的路徑：ready → approved → applying → applied
  assert.equal(canTransition("ready", "approved"), true);
  assert.equal(canTransition("approved", "applying"), true);
  assert.equal(canTransition("applying", "applied"), true);
  // 被拒絕與已復原是終點
  assert.equal(canTransition("rejected", "analyzing"), false);
  assert.equal(canTransition("reverted", "applying"), false);
});

test("contentHash 一律重算，輸入給的雜湊沒有可信度", () => {
  const base = { category: "color", title: "標題", summary: "摘要", rules: ["規則一"] };
  const honest = parseKnowledgeEntry(base, "human-review");
  const forger = parseKnowledgeEntry({ ...base, contentHash: "deadbeef" }, "human-review");
  assert.equal(forger.value?.contentHash, honest.value?.contentHash, "輸入的雜湊必須被忽略");
  assert.notEqual(forger.value?.contentHash, "deadbeef");

  // 長度前綴編碼：把分隔字元嵌進內容裡不能構造出相同雜湊。
  //
  // 這一對在「用分隔字元串接」的實作下會**碰撞**：
  //   a │ b<SEP>c │ [d]      → "a<SEP>b<SEP>c<SEP>d"
  //   a │ b       │ [c, d]   → "a<SEP>b<SEP>c<SEP>d"
  // 也就是說攻擊者可以在 summary 裡塞一個分隔字元，讓自己的條目跟另一條
  // 已審查知識算出相同雜湊，藉此讓 findKnowledgeConflicts 認為「內容相同」
  // 而不回報衝突。長度前綴沒有這個面。
  const SEP = " ";
  const collideA = parseKnowledgeEntry(
    { category: "color", title: "a", summary: `b${SEP}c`, rules: ["d"] },
    "human-review",
  );
  const collideB = parseKnowledgeEntry(
    { category: "color", title: "a", summary: "b", rules: ["c", "d"] },
    "human-review",
  );
  assert.notEqual(
    collideA.value?.contentHash,
    collideB.value?.contentHash,
    "把分隔字元嵌進 summary 就能構造出相同雜湊 —— 欄位邊界必須進雜湊",
  );

  // 內容改了雜湊就要變（這是它唯一的用途）
  const edited = parseKnowledgeEntry({ ...base, rules: ["規則二"] }, "human-review");
  assert.notEqual(edited.value?.contentHash, honest.value?.contentHash);
});
