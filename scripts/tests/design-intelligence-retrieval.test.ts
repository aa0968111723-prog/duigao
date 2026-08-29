/**
 * 知識檢索的測試（PR-DI-01）。
 *
 * 每一條斷言的對象都是**使用者感受得到的事實**（哪一條知識排在前面、
 * 別房的規範會不會外洩、中文問句找不找得到中文知識），不是「函式有回傳值」
 * 或「陣列長度大於 0」這種存在性斷言。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { retrieveKnowledge } from "../../src/features/design-intelligence/retrieval";
import type { KnowledgeEntry } from "../../src/features/design-intelligence/types";

function entry(over: Partial<KnowledgeEntry> & Pick<KnowledgeEntry, "id">): KnowledgeEntry {
  return {
    category: "color",
    title: "標題",
    summary: "摘要",
    rules: ["規則"],
    exceptions: [],
    applicableContexts: [],
    sourceUrl: null,
    sourceTitle: null,
    sourceType: "unknown",
    publisher: null,
    retrievedAt: null,
    reviewedAt: null,
    version: 1,
    trustLevel: "unverified",
    projectSpecific: null,
    status: "draft",
    contentHash: `hash-${over.id}`,
    ...over,
  };
}

test("專案規範排在已核准的通用知識前面，即使字面相關度較低", () => {
  const projectRule = entry({
    id: "brand",
    category: "brand-rules",
    title: "品牌主色",
    summary: "本專案主色固定為 #6157ef",
    rules: ["主要按鈕一律使用 #6157ef"],
    trustLevel: "project",
    status: "approved",
    projectSpecific: "room-1",
  });
  const generalRule = entry({
    id: "wcag",
    category: "accessibility",
    title: "內文與背景的對比至少 4.5:1",
    summary: "對比 對比 對比 配色 配色",
    rules: ["一般內文與背景對比 ≥ 4.5:1"],
    trustLevel: "approved",
    status: "approved",
  });

  const result = retrieveKnowledge([generalRule, projectRule], {
    goal: "對比 配色",       // 字面上完全指向 generalRule
    projectId: "room-1",
  });

  assert.equal(result.hits[0]?.entry.id, "brand", "專案規範必須排第一，信任等級是主鍵");
  assert.equal(result.hits[1]?.entry.id, "wcag");
  // 而且要說得出為什麼選它 —— 提案要能引用這個理由
  assert.ok(
    result.hits[0]?.matchedOn.some((reason) => reason.includes("自有規範")),
    "必須說明專案規範是憑什麼被選進來的",
  );
});

test("未審查的搜尋結果排在已核准知識之後", () => {
  const researched = entry({
    id: "machine",
    title: "對比 配色 對比 配色",
    summary: "對比 配色 對比 配色",
    trustLevel: "machine",
    status: "machine-researched",
  });
  const approved = entry({ id: "approved", title: "對比", trustLevel: "approved", status: "approved" });

  const result = retrieveKnowledge([researched, approved], { goal: "對比 配色" });
  assert.equal(result.hits[0]?.entry.id, "approved", "已核准的知識必須壓過機器搜來的");
});

test("別的房間的專案規範不會外洩到這個房間", () => {
  const otherRoom = entry({
    id: "other",
    title: "對比",
    trustLevel: "project",
    status: "approved",
    projectSpecific: "room-999",
  });
  const result = retrieveKnowledge([otherRoom], { goal: "對比", projectId: "room-1" });
  assert.equal(result.hits.length, 0, "別房的規範不得進入檢索結果");
  assert.equal(result.excluded[0]?.reason, "屬於其他專案的規範");

  // 沒有帶 projectId 時也一樣 —— 不能因為「沒指定房間」就全部放行
  const noRoom = retrieveKnowledge([otherRoom], { goal: "對比" });
  assert.equal(noRoom.hits.length, 0);
});

test("中文問句找得到中文知識（bigram 召回）", () => {
  // 這條是為了讓「中文召回率」這件事有一個真的量測，而不是靠猜。
  const contrast = entry({
    id: "contrast",
    title: "內文與背景的對比至少 4.5:1",
    summary: "一般大小文字與其背景的對比至少 4.5:1",
    rules: ["一般內文與背景對比 ≥ 4.5:1"],
    trustLevel: "approved",
    status: "approved",
  });
  const spacing = entry({
    id: "spacing",
    title: "觸控目標至少 24×24 CSS 像素",
    summary: "可點擊的目標尺寸下限",
    rules: ["觸控目標 ≥ 24×24"],
    trustLevel: "approved",
    status: "approved",
  });

  // 中文沒有空白分詞，靠 bigram：「對比」「比太」…會命中「對比」
  const hit = retrieveKnowledge([contrast, spacing], { goal: "海報的對比太低看不清楚" });
  assert.equal(hit.hits[0]?.entry.id, "contrast", "中文問句要能命中中文知識");

  // 反面：完全無關的中文問句不該把知識硬塞進來
  const miss = retrieveKnowledge([contrast], { goal: "幫我訂便當" });
  assert.equal(miss.hits.length, 0, "無關的問句不該回傳知識");
  assert.equal(miss.excluded[0]?.reason, "與這次的提問無關");
});

test("已知的天花板：同義但不同字的說法會漏掉", () => {
  // 誠實記錄 lexical 檢索的極限。這條測試存在的目的**不是**證明功能好，
  // 而是把「它做不到什麼」釘住 —— 哪天換成語意檢索，這條會紅，那是好事。
  const contrast = entry({
    id: "contrast",
    title: "內文與背景的對比至少 4.5:1",
    summary: "文字與背景的亮度差",
    rules: ["對比 ≥ 4.5:1"],
    trustLevel: "approved",
    status: "approved",
  });
  const result = retrieveKnowledge([contrast], { goal: "字看起來糊糊的" });
  assert.equal(result.hits.length, 0, "lexical 檢索抓不到同義改寫 —— 這是已知天花板");
});

test("停用的知識不會被檢索到，而且會說明被排除的理由", () => {
  const deprecated = entry({
    id: "old",
    title: "對比",
    trustLevel: "approved",
    status: "deprecated",
  });
  const result = retrieveKnowledge([deprecated], { goal: "對比" });
  assert.equal(result.hits.length, 0);
  assert.equal(result.excluded[0]?.reason, "已停用的知識條目");
});

test("互相矛盾的知識被回報，而不是自動選一邊", () => {
  const a = entry({
    id: "a",
    category: "typography",
    title: "行高 1.5",
    summary: "內文行高至少 1.5",
    rules: ["行高 ≥ 1.5"],
    applicableContexts: ["web"],
    trustLevel: "approved",
    status: "approved",
    contentHash: "hash-a",
  });
  const b = entry({
    id: "b",
    category: "typography",
    title: "行高 1.2",
    summary: "內文行高 1.2 即可",
    rules: ["行高 = 1.2"],
    applicableContexts: ["web"],
    trustLevel: "approved",
    status: "approved",
    contentHash: "hash-b",
  });
  const result = retrieveKnowledge([a, b], { goal: "行高", targetType: "website" });
  assert.equal(result.hits.length, 2, "兩邊都要留著給人看");
  assert.ok(result.conflicts.length >= 1, "矛盾必須被回報");
  assert.deepEqual(result.conflicts[0]?.entryIds.sort(), ["a", "b"]);
});

test("作品類型會帶進檢索，而且說得出是因為哪個脈絡命中", () => {
  const videoRule = entry({
    id: "video",
    category: "video",
    title: "分鏡",
    summary: "分鏡摘要",
    rules: ["每個鏡頭標註秒數"],
    applicableContexts: ["video", "storyboard"],
    trustLevel: "approved",
    status: "approved",
  });
  const result = retrieveKnowledge([videoRule], { goal: "幫我看看", targetType: "video" });
  assert.equal(result.hits[0]?.entry.id, "video");
  assert.ok(result.hits[0]?.matchedOn.some((reason) => reason.includes("video")));

  // 換一個作品類型就不該命中
  const wrongType = retrieveKnowledge([videoRule], { goal: "幫我看看", targetType: "poster" });
  assert.equal(wrongType.hits.length, 0);
});

// ===========================================================================
// 對抗審查（grok，PR-DI-01）後補的反例
// ===========================================================================

test("空字串或缺欄的 projectSpecific 不會被當成通用知識", () => {
  // 舊版用 truthy 判斷（`if (entry.projectSpecific && ...)`），於是
  // `projectSpecific: ""` 直接被當成通用知識放行 —— 而那正是攻擊者控制的欄位。
  const blank = entry({
    id: "blank",
    title: "對比",
    trustLevel: "project",
    status: "approved",
    projectSpecific: "",
  });
  const result = retrieveKnowledge([blank], { goal: "對比", projectId: "room-1" });
  assert.equal(result.hits.length, 0, "空字串的 projectSpecific 不是「通用」，是壞資料");
  assert.equal(result.excluded[0]?.reason, "專案識別碼格式不正確");

  // 只有空白也一樣
  const spaces = retrieveKnowledge([{ ...blank, id: "spaces", projectSpecific: "   " }], {
    goal: "對比",
    projectId: "room-1",
  });
  assert.equal(spaces.hits.length, 0);
});

test("機器搜來的結果不能靠自帶 projectSpecific 免詞面命中", () => {
  // 機器結果可以自己帶一個 projectSpecific。parseKnowledgeEntry 會把信任降成
  // machine，但如果檢索只看 projectSpecific，那條降級過的結果仍然免詞面命中
  // 直接進 hits —— 這不是跨房外洩，是污染本房的檢索。
  const machineClaim = entry({
    id: "machine-claim",
    title: "網路上看到的配色建議",
    summary: "與提問完全無關的內容",
    rules: ["用漸層"],
    trustLevel: "machine",
    status: "machine-researched",
    projectSpecific: "room-1",
  });
  const result = retrieveKnowledge([machineClaim], { goal: "行高", projectId: "room-1" });
  assert.equal(result.hits.length, 0, "信任等級不是 project 就不該享有免命中豁免");
  assert.equal(result.excluded[0]?.reason, "與這次的提問無關");

  // 真正的專案規範仍然享有豁免
  const realRule = retrieveKnowledge([{ ...machineClaim, id: "real", trustLevel: "project", status: "approved" }], {
    goal: "行高",
    projectId: "room-1",
  });
  assert.equal(realRule.hits.length, 1);
});

test("沒有標脈絡的規則與有標脈絡的規則之間的矛盾要被回報", () => {
  // 舊版把沒有 applicableContexts 的條目放進一個叫 "*" 的桶，於是
  //「行高 1.5（不限脈絡）」與「行高 1.2（web）」落在不同桶，明顯互斥卻不回報。
  const general = entry({
    id: "general",
    category: "typography",
    title: "行高 1.5",
    summary: "內文行高至少 1.5",
    rules: ["行高 ≥ 1.5"],
    applicableContexts: [],
    trustLevel: "approved",
    status: "approved",
    contentHash: "h-general",
  });
  const webOnly = entry({
    id: "web",
    category: "typography",
    title: "行高 1.2",
    summary: "網頁上行高 1.2 即可",
    rules: ["行高 = 1.2"],
    applicableContexts: ["web"],
    trustLevel: "approved",
    status: "approved",
    contentHash: "h-web",
  });
  const result = retrieveKnowledge([general, webOnly], { goal: "行高", targetType: "website" });
  assert.equal(result.hits.length, 2, "兩條都要留著給人看");
  assert.equal(result.conflicts.length, 1, `矛盾要被回報且只回報一次，實得 ${result.conflicts.length}`);
  assert.deepEqual(result.conflicts[0].entryIds.sort(), ["general", "web"]);
});

test("跨類別的同一個量測對象也算衝突（品牌規範 vs 通用規範）", () => {
  // 驗收案例 E 實測到的缺口：品牌規範在 brand-rules 類別、無障礙知識在
  // typography 類別，只在同類別內比對就永遠不會發現它們直接矛盾。
  // 這是最容易真實發生的一種衝突。
  const brand = entry({
    id: "brand",
    category: "brand-rules",
    title: "品牌行高",
    summary: "本專案內文行高固定 1.2",
    rules: ["內文行高 = 1.2"],
    trustLevel: "project",
    status: "approved",
    projectSpecific: "room-1",
    contentHash: "h-brand",
  });
  const wcag = entry({
    id: "wcag",
    category: "typography",
    title: "內文行高至少 1.5",
    summary: "WCAG 建議",
    rules: ["內文行高 ≥ 1.5"],
    trustLevel: "approved",
    status: "approved",
    contentHash: "h-wcag",
  });

  const result = retrieveKnowledge([brand, wcag], { goal: "內文行高", projectId: "room-1" });
  assert.equal(result.conflicts.length, 1, `跨類別的矛盾要被回報，實得 ${result.conflicts.length}`);
  assert.deepEqual(result.conflicts[0].entryIds.sort(), ["brand", "wcag"]);

  // 同一個對象、同一個值不算衝突
  const agreeing = retrieveKnowledge(
    [{ ...brand, id: "a", rules: ["內文行高 ≥ 1.5"], contentHash: "h-a" }, wcag],
    { goal: "內文行高", projectId: "room-1" },
  );
  assert.equal(agreeing.conflicts.length, 0, "兩條規則說同一件事不是矛盾");

  // 不同對象不算衝突
  const unrelated = retrieveKnowledge(
    [{ ...brand, id: "b", rules: ["觸控目標 ≥ 24"], contentHash: "h-b" }, wcag],
    { goal: "內文行高 觸控目標", projectId: "room-1" },
  );
  assert.equal(unrelated.conflicts.length, 0, "行高與觸控目標無關，不該被當成矛盾");
});

test("相容的約束不算矛盾（較嚴的下限滿足較寬的）", () => {
  // 把「觸控目標至少 24」與「至少 44」當成矛盾去逼使用者選一邊，
  // 最糟的結果是品牌那條較嚴的規則被丟掉 —— 對抗審查點名的正是這件事。
  const loose = entry({
    id: "loose",
    category: "accessibility",
    title: "觸控目標下限",
    summary: "WCAG",
    rules: ["觸控目標至少 24"],
    trustLevel: "approved",
    status: "approved",
    contentHash: "h-loose",
  });
  const strict = entry({
    id: "strict",
    category: "brand-rules",
    title: "品牌觸控目標",
    summary: "本專案更嚴",
    rules: ["觸控目標至少 44"],
    trustLevel: "project",
    status: "approved",
    projectSpecific: "room-1",
    contentHash: "h-strict",
  });
  const compatible = retrieveKnowledge([loose, strict], { goal: "觸控目標", projectId: "room-1" });
  assert.deepEqual(compatible.conflicts, [], "兩個下限相容，不該被回報成矛盾");

  // 區間也相容
  const lower = entry({ id: "lo", category: "typography", title: "行高下限", summary: "s", rules: ["內文行高不得低於 1.2"], trustLevel: "approved", status: "approved", contentHash: "h-lo" });
  const upper = entry({ id: "hi", category: "typography", title: "行高上限", summary: "s", rules: ["內文行高不得超過 1.8"], trustLevel: "approved", status: "approved", contentHash: "h-hi" });
  assert.deepEqual(
    retrieveKnowledge([lower, upper], { goal: "內文行高" }).conflicts,
    [],
    "1.2 ≤ x ≤ 1.8 是一個合理的區間，不是矛盾",
  );

  // 但等值落在下限之外就是真的矛盾
  const fixed = entry({ id: "fixed", category: "brand-rules", title: "行高固定", summary: "s", rules: ["內文行高 = 1.0"], trustLevel: "project", status: "approved", projectSpecific: "room-1", contentHash: "h-fixed" });
  const real = retrieveKnowledge([lower, fixed], { goal: "內文行高", projectId: "room-1" });
  assert.equal(real.conflicts.length, 1, "1.0 違反「不得低於 1.2」，這是真的矛盾");
});

test("一條規則裡的第二組數值也會被比對", () => {
  // 舊版的正則只取第一個數字，於是「標題字級 ≥ 24，內文 ≥ 16」裡的
  // 「內文 ≥ 16」完全看不到（對抗審查實測到的）。
  const combined = entry({
    id: "combined",
    category: "typography",
    title: "字級規範",
    summary: "s",
    rules: ["標題字級 ≥ 24，內文 ≥ 16"],
    trustLevel: "approved",
    status: "approved",
    contentHash: "h-combined",
  });
  const bodyOnly = entry({
    id: "body",
    category: "brand-rules",
    title: "內文字級固定",
    summary: "s",
    rules: ["內文 = 12"],
    trustLevel: "project",
    status: "approved",
    projectSpecific: "room-1",
    contentHash: "h-body",
  });
  const result = retrieveKnowledge([combined, bodyOnly], { goal: "內文 字級", projectId: "room-1" });
  assert.equal(result.conflicts.length, 1, "內文 12 違反「≥ 16」，要被抓到");
  assert.deepEqual(result.conflicts[0].entryIds.sort(), ["body", "combined"]);
});
