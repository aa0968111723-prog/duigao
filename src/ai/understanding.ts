import type { CommentPin, PlanDocument, Version } from "../lib/types";
import type { AssetAnalysis, AssetKind } from "./types";

export type TopicHit = { topic: string; label: string };

export const TOPIC_LEXICON: { topic: string; label: string; pattern: RegExp }[] = [
  { topic: "tea", label: "茶會", pattern: /茶會|品茶|茶席/ },
  { topic: "stall", label: "擺攤", pattern: /擺攤|攤位|迎新攤/ },
  { topic: "recruit", label: "招生", pattern: /招生|招募|新生|入社/ },
  { topic: "qr", label: "QR／報名", pattern: /QR|qr|報名|表單|連結/ },
  { topic: "talk", label: "演講", pattern: /演講|講座|分享會/ },
  { topic: "followup", label: "後續追蹤", pattern: /追蹤|後續|聯絡|回訪|名單/ },
  { topic: "visual", label: "主視覺", pattern: /主視覺|海報|文宣|封面/ },
  { topic: "people", label: "人物", pattern: /人物|同學|學長|學姊|社員/ },
  { topic: "scene", label: "場景", pattern: /場景|現場|戶外|教室|校園/ },
  { topic: "interaction", label: "互動", pattern: /互動|體驗|遊戲|闖關/ },
];

export function extractTopics(text: string): string[] {
  const found = TOPIC_LEXICON.filter((entry) => entry.pattern.test(text)).map((entry) => entry.label);
  return [...new Set(found)];
}

export function combinedText(...parts: Array<string | undefined | null>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join("\n");
}

/**
 * Understand a poster/photo from signals the room already has, plus an optional
 * vision payload. Filenames are never the answer.
 */
export function understandImage(input: {
  title: string;
  versionLabel?: string;
  comments?: Array<Pick<CommentPin, "body" | "suggestion">>;
  analysis?: Pick<AssetAnalysis, "summary" | "topics" | "ocrText" | "caption" | "source">;
}): { summary: string; topics: string[]; evidence: string[]; source: AssetAnalysis["source"] } {
  const commentText = (input.comments ?? [])
    .map((comment) => combinedText(comment.body, comment.suggestion))
    .filter(Boolean)
    .join("\n");
  const body = combinedText(
    input.analysis?.caption,
    input.analysis?.ocrText,
    input.analysis?.summary,
    input.title,
    input.versionLabel,
    commentText,
  );
  const topics = [...new Set([...(input.analysis?.topics ?? []), ...extractTopics(body)])];
  const evidence: string[] = [];
  if (input.analysis?.caption) evidence.push(input.analysis.caption);
  if (input.analysis?.ocrText) evidence.push(input.analysis.ocrText);
  if (commentText) evidence.push(commentText);
  if (input.analysis?.summary) evidence.push(input.analysis.summary);
  const summary = input.analysis?.summary?.trim()
    || input.analysis?.caption?.trim()
    || summarizePoster(input.title, topics, commentText);
  return {
    summary,
    topics,
    evidence,
    source: input.analysis?.source ?? (input.analysis?.caption || input.analysis?.ocrText ? "vision" : "structured"),
  };
}

function summarizePoster(title: string, topics: string[], comments: string): string {
  if (comments.trim()) {
    const first = comments.split(/\n+/)[0]?.trim();
    if (first) return `${title}：${first}`;
  }
  if (topics.length) return `${title}，內容涵蓋${topics.join("、")}。`;
  return `${title}。目前只有標題，還沒有足以描述畫面的文字或分析。`;
}

export type ExtractedDocument = {
  title: string;
  body: string;
  topics: string[];
  checklist: Array<{ text: string; checked: boolean }>;
  missing: Array<{ id: string; label: string }>;
};

export const STALL_PLAN_REQUIREMENTS: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: "when-where", label: "時間地點", pattern: /時間|地點|週|點|樓|教室|中庭/ },
  { id: "people", label: "人員分工", pattern: /人員|輪班|負責|分工/ },
  { id: "materials", label: "物料", pattern: /物料|桌|椅|易拉|道具/ },
  { id: "visual", label: "文宣主視覺", pattern: /文宣|主視覺|海報|照片/ },
  { id: "interaction", label: "攤位互動", pattern: /互動|體驗|遊戲|闖關/ },
  { id: "signup", label: "報名／QR", pattern: /報名|QR|qr|表單/ },
  { id: "followup", label: "報名後追蹤", pattern: /追蹤|後續|聯絡|回訪|名單/ },
];

export function extractPlanDocument(plan: PlanDocument): ExtractedDocument {
  const checklist = plan.blocks
    .filter((block): block is Extract<PlanDocument["blocks"][number], { kind: "checklist" }> => block.kind === "checklist")
    .map((block) => ({ text: block.text, checked: block.checked }));
  const body = combinedText(
    plan.title,
    plan.description,
    ...plan.blocks.map((block) => ("text" in block ? block.text : "")),
  );
  const topics = extractTopics(body);
  const missing = STALL_PLAN_REQUIREMENTS.filter((requirement) => !requirement.pattern.test(body));
  return { title: plan.title, body, topics, checklist, missing };
}

export function assetKindForBranch(branchType: "poster" | "video" | "plan" | "copy"): AssetKind {
  if (branchType === "poster") return "poster";
  if (branchType === "video") return "video";
  if (branchType === "plan") return "plan";
  return "copy";
}

export function rankPhotosForUse(
  photos: Array<{ id: string; title: string; filename?: string; topics: string[]; summary: string }>,
  use: string,
): Array<{ id: string; title: string; score: number; reason: string }> {
  const wanted = extractTopics(use);
  return photos
    .map((photo) => {
      const overlap = photo.topics.filter((topic) => wanted.includes(topic) || use.includes(topic));
      const filenameOnly = Boolean(photo.filename && photo.title === photo.filename && !photo.summary);
      const score = filenameOnly ? 0 : overlap.length * 3 + (photo.summary ? 1 : 0);
      const reason = filenameOnly
        ? "只有檔名，沒有內容理解，不能當成適合素材。"
        : overlap.length
          ? `內容涵蓋${overlap.join("、")}，較符合「${use}」。`
          : photo.summary
            ? `已讀懂內容（${photo.summary}），但與「${use}」重疊不多。`
            : "缺少畫面理解。";
      return { id: photo.id, title: photo.title, score, reason };
    })
    .sort((a, b) => b.score - a.score);
}

export function describeVersion(version: Pick<Version, "id" | "label">): string {
  return version.label;
}
