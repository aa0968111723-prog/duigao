/**
 * Design Intelligence — 知識檢索（PR-DI-01）
 *
 * 任務書第六節：「專案規範優先於通用設計知識；通用知識優先於未經審查的搜尋
 * 結果」。這個檔案是那句話的可執行版本。
 *
 * **不是語意檢索**。這個 repo 沒有 pgvector（`asset_embeddings` 是零讀寫的
 * jsonb 死碼），所以這裡用的是 lexical 打分，沿用 `assetIntelligence.ts` 的
 * 同一套 tokenizer（詞 + 中日韓字元 bigram）—— 換句話說它比對的是字面，
 * 「配色不協調」找不到只寫「色彩對比」的條目。這是已知的天花板，不是 bug，
 * 但也不該被說成「AI 找到了相關知識」。
 */
import type {
  DesignTargetType,
  KnowledgeCategory,
  KnowledgeEntry,
} from "./types";
import { findKnowledgeConflicts, rankKnowledge } from "./schema";

export type KnowledgeQuery = {
  /** 使用者的原話。不做改寫 —— 改寫過的查詢無法解釋為什麼命中。 */
  goal: string;
  targetType?: DesignTargetType;
  /** 限定類別；不給就全類別。 */
  categories?: readonly KnowledgeCategory[];
  /**
   * 目前這個房間。**只有屬於這個房間的專案規範會被納入** ——
   * RLS 已經擋過一層，這裡是第二層：就算呼叫端把別房的規範塞進 entries，
   * 也不會被用來影響這個房間的 AI 判斷。
   */
  projectId?: string | null;
  limit?: number;
};

export type KnowledgeHit = {
  entry: KnowledgeEntry;
  score: number;
  /**
   * 為什麼選它。提案要能說出「這條建議的依據是哪一條知識、為什麼被認為相關」，
   * 所以命中原因必須跟著結果一起回去，而不是只回一個分數。
   */
  matchedOn: string[];
};

export type KnowledgeRetrieval = {
  hits: KnowledgeHit[];
  /**
   * 互相矛盾的條目。**不自動裁決** —— 任務書第九節：「衝突的資訊不得自動採信
   * 其中一方」。呼叫端要把它顯示給人看。
   */
  conflicts: Array<{ category: string; context: string; entryIds: string[] }>;
  /** 被排除的條目與理由。沉默地丟掉知識會讓人以為「AI 沒查到」。 */
  excluded: Array<{ entryId: string; reason: string }>;
};

/** 與 `assetIntelligence.ts` 同一套：詞 + 中日韓字元 bigram。 */
function lexicalTokens(value: string): string[] {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\u3400-\u9fff]+/gu, " ");
  const words = normalized.split(/\s+/).filter(Boolean);
  const chars = [...normalized.replace(/\s/g, "")];
  const bigrams = chars.length > 1 ? chars.slice(0, -1).map((char, i) => char + chars[i + 1]) : [];
  return [...new Set([...words, ...bigrams])];
}

/** 作品類型對應的適用脈絡標籤（與 seed 的 applicable_contexts 對齊）。 */
const TARGET_CONTEXTS: Record<DesignTargetType, readonly string[]> = {
  poster: ["print", "poster", "social-media", "static"],
  video: ["video", "motion", "storyboard"],
  plan: ["presentation", "document", "planning"],
  website: ["web", "responsive", "mobile", "tablet"],
  board: ["whiteboard", "canvas", "mobile"],
};

/**
 * 正規化專案識別碼。
 *
 * `null` = 通用知識；字串 = 專案 id；`"invalid"` = 壞資料（空字串、只有
 * 空白）。刻意把壞資料跟「通用」分開 —— 兩者的處置完全不同。
 */
function normalizeProjectId(value: string | null | undefined): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  return trimmed === "" ? "invalid" : trimmed;
}

export function retrieveKnowledge(
  entries: readonly KnowledgeEntry[],
  query: KnowledgeQuery,
): KnowledgeRetrieval {
  const excluded: KnowledgeRetrieval["excluded"] = [];
  const eligible: KnowledgeEntry[] = [];

  for (const entry of entries) {
    if (entry.status === "deprecated") {
      excluded.push({ entryId: entry.id, reason: "已停用的知識條目" });
      continue;
    }
    // 別房的專案規範一律不納入 —— 這是 RLS 之外的第二道。
    //
    // 用「正規化後嚴格比較」而不是 truthy 判斷：`projectSpecific: ""` 或
    // 缺欄在 truthy 判斷下會被當成通用知識直接放行，而那正是攻擊者能控制的
    // 欄位（對抗審查實測到的）。空字串不是「通用」，是「壞資料」。
    const owner = normalizeProjectId(entry.projectSpecific);
    const current = normalizeProjectId(query.projectId);
    if (owner === "invalid") {
      excluded.push({ entryId: entry.id, reason: "專案識別碼格式不正確" });
      continue;
    }
    if (owner !== null && owner !== current) {
      excluded.push({ entryId: entry.id, reason: "屬於其他專案的規範" });
      continue;
    }
    if (query.categories?.length && !query.categories.includes(entry.category)) {
      excluded.push({ entryId: entry.id, reason: `不在指定類別內：${entry.category}` });
      continue;
    }
    eligible.push(entry);
  }

  const queryTokens = new Set(lexicalTokens(query.goal));
  const wantedContexts = query.targetType ? TARGET_CONTEXTS[query.targetType] : [];

  const scored: KnowledgeHit[] = [];
  for (const entry of eligible) {
    const matchedOn: string[] = [];
    let score = 0;

    if (queryTokens.size) {
      const haystack = new Set(
        lexicalTokens([entry.title, entry.summary, ...entry.rules, ...entry.applicableContexts].join(" ")),
      );
      let overlap = 0;
      for (const token of queryTokens) if (haystack.has(token)) overlap += 1;
      if (overlap > 0) {
        score += overlap / queryTokens.size;
        matchedOn.push(`與提問字面重疊 ${overlap}/${queryTokens.size}`);
      }
    }

    const contextHit = wantedContexts.filter((context) => entry.applicableContexts.includes(context));
    if (contextHit.length) {
      score += 0.5;
      matchedOn.push(`適用於${query.targetType}：${contextHit.join("、")}`);
    }

    // 專案規範就算字面沒對上也要納入 —— 品牌規範不該因為使用者沒說出
    // 「品牌色」三個字就被略過。
    //
    // 但**只有信任等級真的是 project 的**才享有這個豁免。機器搜來的結果
    // 可以自己帶一個 `projectSpecific`，`parseKnowledgeEntry` 會把信任降成
    // machine，可是如果這裡只看 `projectSpecific`，那條降級過的機器結果
    // 仍然免詞面命中直接進 hits —— 不是跨房外洩，是污染本房檢索。
    if (normalizeProjectId(entry.projectSpecific) !== null && entry.trustLevel === "project") {
      matchedOn.push("這個專案的自有規範");
    } else if (!matchedOn.length) {
      excluded.push({ entryId: entry.id, reason: "與這次的提問無關" });
      continue;
    }
    scored.push({ entry, score, matchedOn });
  }

  // 排序：**信任等級是主鍵**（專案規範 > 已核准 > 已審閱 > 機器 > 未驗證），
  // 字面相關度只是同一個信任等級內的次鍵。
  //
  // 這是刻意的：任務書要求專案規範優先，如果讓相關度當主鍵，一條字面命中很多
  // 的未審查搜尋結果就會壓過房間自己的品牌規範 —— 那正是不該發生的事。
  // 相關度負責的是「要不要進來」（上面的 excluded），不是「誰排前面」。
  const trustOrder = new Map(rankKnowledge(scored.map((hit) => hit.entry)).map((entry, index) => [entry.id, index]));
  const hits = scored
    .sort((a, b) => {
      const trust = (trustOrder.get(a.entry.id) ?? 0) - (trustOrder.get(b.entry.id) ?? 0);
      if (trust !== 0) return trust;
      return b.score - a.score;
    })
    .slice(0, Math.max(1, query.limit ?? 12));

  return {
    hits,
    conflicts: findKnowledgeConflicts(hits.map((hit) => hit.entry)),
    excluded,
  };
}
