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
