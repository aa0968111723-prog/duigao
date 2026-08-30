/**
 * In-room Grok agent contract.
 *
 * One bounded 繁中 card per turn. AI may only propose; a human 採用 writes
 * existing visual_proposals / plan-draft apply. Never versions, originals,
 * or Storage objects. tku-zen-agent stays on the same action union.
 */
import { parseFunctionPayload } from "../cloud/apiResponse";
import { stripSecrets } from "../../supabase/functions/_shared/roomContext.ts";

export const AGENT_UNCONFIGURED_COPY = "AI 服務尚未設定";
export const IMAGINE_NOT_VERSION_COPY = "已生成一張圖，尚未成為正式版本";
export const DEFAULT_GROK_TEXT_MODEL = "grok-4-1-fast-non-reasoning";
export const DEFAULT_GROK_IMAGE_MODEL = "grok-imagine-image";
export const DEFAULT_GROK_VIDEO_MODEL = "grok-imagine-video";
export const DEFAULT_MAX_USD_PER_TURN = 0.05;
export const IMAGINE_IMAGE_USD = 0.02;
export const IMAGINE_VIDEO_USD_PER_SEC: Record<string, number> = {
  "480p": 0.05,
  "720p": 0.07,
};

export const ROOM_AGENT_TOOLS = [
  "list_room_contents",
  "get_version_brief",
  "list_open_comments",
  "propose_edit_text",
  "propose_add_shape",
  "propose_move_item",
  "propose_add_image",
  "imagine_image",
  "imagine_video",
  "create_plan_draft",
  "refuse_with_reason",
] as const;

export const ROOM_AGENT_FORBIDDEN_TOOLS = [
  "overwrite_version",
  "delete_version",
  "delete_branch",
  "replace_storage_object",
  "send_as_member",
  "expose_invite",
  "expose_service_role",
] as const;

export const ROOM_AGENT_ACTION_TYPES = [
  "create_comment",
  "create_poll",
  "create_plan_draft",
  "add_whiteboard_node",
  "propose_edit_text",
  "propose_add_shape",
  "propose_move_item",
  "propose_add_image",
  "imagine_image",
  "imagine_video",
  "refuse_with_reason",
] as const;

export type RoomAgentToolName = (typeof ROOM_AGENT_TOOLS)[number];
export type RoomAgentForbiddenTool = (typeof ROOM_AGENT_FORBIDDEN_TOOLS)[number];
export type RoomAgentActionType = (typeof ROOM_AGENT_ACTION_TYPES)[number];

export type RoomAgentRole = "owner" | "manager" | "reviewer" | "editor" | "member";

export type RoomAgentContent = {
  branchId: string;
  type: "poster" | "video" | "plan";
  name: string;
  latestVersionLabel: string;
  openCommentCount: number;
};

export type RoomAgentFocus = {
  branchId?: string;
  versionId?: string;
  label: string;
  width?: number;
  height?: number;
  thumbnail?: { kind: "signed-url" | "description"; value: string };
};

export type RoomAgentComment = {
  id: string;
  versionId?: string;
  body: string;
  regionSummary?: string;
};

export type RoomAgentWorkItem = {
  id: string;
  type: string;
  role?: string;
  text?: string;
  approxPosition?: string;
};

export type RoomAgentCard = {
  room: { id: string; title: string; role: RoomAgentRole | string };
  contents: RoomAgentContent[];
  focus?: RoomAgentFocus;
  comments: RoomAgentComment[];
  workLayer?: { proposalId: string; status: string; items: RoomAgentWorkItem[] };
  allowedActions: RoomAgentToolName[];
  spendPolicy: {
    maxUsdThisTurn: number;
    allowImagineImage: boolean;
    allowImagineVideo: boolean;
  };
  truncated: boolean;
};

export type RoomAgentCardInput = {
  room: { id: string; title: string; role: string };
  contents?: Array<{
    branchId: string;
    type?: string;
    name: string;
    latestVersionLabel?: string;
    openCommentCount?: number;
  }>;
  focus?: {
    branchId?: string;
    versionId?: string;
    label: string;
    width?: number;
    height?: number;
    thumbnailPath?: string;
    thumbnailDescription?: string;
    signedUrl?: string;
    invite?: string;
    inviteHash?: string;
  };
  comments?: Array<{
    id: string;
    versionId?: string;
    body: string;
    region?: string;
    regionSummary?: string;
    resolved?: boolean;
  }>;
  discussion?: string;
  workLayer?: {
    proposalId: string;
    status: string;
    items?: Array<Record<string, unknown>>;
  };
  spendPolicy?: {
    maxUsdThisTurn?: number;
    allowImagineImage?: boolean;
    allowImagineVideo?: boolean;
  };
  maxComments?: number;
};

export type RoomAgentToolContext = {
  card: RoomAgentCard;
  imagineVideoConfirmed?: boolean;
  spentUsd?: number;
  versionStoragePaths?: Record<string, string>;
};

export type RoomAgentToolResult = {
  ok: boolean;
  refused?: boolean;
  recorded?: boolean;
  tool: string;
  preview?: string;
  proposalId?: string;
  data?: unknown;
  error?: string;
  spentUsd?: number;
};

const MAX_CONTENTS = 24;
const MAX_COMMENTS = 8;
const MAX_WORK_ITEMS = 12;
const MAX_BODY = 280;
const STORAGE_PATH = /(?:^|\/)rooms\/[0-9a-f-]{8,}\/(?:versions|videos|assets)\//i;
const DATA_URL = /data:(?:image|video|application)\/[a-z0-9.+-]+;base64,/i;
const INVITE_LEAK = /invite(?:[_-]?hash|[_-]?token)?\s*[:=]/i;
const SERVICE_ROLE = /service[_-]?role/i;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function contentType(value: string): "poster" | "video" | "plan" {
  if (value === "video" || value === "plan") return value;
  return "poster";
}

function roleOf(value: string): string {
  if (value === "owner" || value === "manager" || value === "reviewer" || value === "editor" || value === "member") {
    return value;
  }
  return "member";
}

function scrubValue(value: string): string {
  return value
    .replace(DATA_URL, "[二進位已省略]")
    .replace(/(?:invite|access[_-]?token|service[_-]?role)[=:][^\s,;]+/gi, "[機密已省略]")
    .replace(STORAGE_PATH, "[路徑已省略]")
    .slice(0, 500);
}

function isHttpsUrl(value: string): boolean {
  return /^https:\/\/[^\s]+$/i.test(value) && !/invite/i.test(value);
}

function thumbnailFromFocus(focus: NonNullable<RoomAgentCardInput["focus"]>): RoomAgentFocus["thumbnail"] | undefined {
  const description = scrubValue(text(focus.thumbnailDescription));
  const signed = text(focus.signedUrl);
  if (signed && isHttpsUrl(signed) && !DATA_URL.test(signed) && !STORAGE_PATH.test(signed)) {
    return { kind: "signed-url", value: signed.slice(0, 500) };
  }
  if (description) return { kind: "description", value: description };
  const path = text(focus.thumbnailPath);
  if (path && !STORAGE_PATH.test(path) && isHttpsUrl(path)) {
    return { kind: "signed-url", value: path.slice(0, 500) };
  }
  if (path && !STORAGE_PATH.test(path) && !DATA_URL.test(path)) {
    return { kind: "description", value: scrubValue(path) };
  }
  return undefined;
}

function workItems(raw: Array<Record<string, unknown>> | undefined): RoomAgentWorkItem[] {
  if (!raw) return [];
  const out: RoomAgentWorkItem[] = [];
  for (const item of raw.slice(0, MAX_WORK_ITEMS)) {
    const id = text(item.id);
    const type = text(item.type, "text");
    if (!id) continue;
    const x = typeof item.x === "number" ? item.x : undefined;
    const y = typeof item.y === "number" ? item.y : undefined;
    out.push({
      id: id.slice(0, 80),
      type: type.slice(0, 40),
      role: text(item.role).slice(0, 40) || undefined,
      text: scrubValue(text(item.text)).slice(0, 160) || undefined,
      approxPosition: x != null && y != null ? `約 ${Math.round(x)},${Math.round(y)}` : undefined,
    });
  }
  return out;
}

export function buildRoomAgentCard(input: RoomAgentCardInput): RoomAgentCard {
  const openComments = (input.comments ?? []).filter((item) => !item.resolved);
  const truncated = Boolean(
    (input.contents?.length ?? 0) > MAX_CONTENTS
    || openComments.length > (input.maxComments ?? MAX_COMMENTS)
    || (input.discussion && input.discussion.length > 0),
  );
  const comments: RoomAgentComment[] = openComments
    .slice(0, input.maxComments ?? MAX_COMMENTS)
    .map((item) => ({
      id: text(item.id).slice(0, 80),
      versionId: text(item.versionId).slice(0, 80) || undefined,
      body: scrubValue(text(item.body)).slice(0, MAX_BODY),
      regionSummary: scrubValue(text(item.regionSummary || item.region)).slice(0, 80) || undefined,
    }))
    .filter((item) => item.id && item.body);

  const focus = input.focus
    ? {
        branchId: text(input.focus.branchId).slice(0, 80) || undefined,
        versionId: text(input.focus.versionId).slice(0, 80) || undefined,
        label: scrubValue(text(input.focus.label, "目前內容")).slice(0, 120),
        width: typeof input.focus.width === "number" ? input.focus.width : undefined,
        height: typeof input.focus.height === "number" ? input.focus.height : undefined,
        thumbnail: thumbnailFromFocus(input.focus),
      }
    : undefined;

  const spend = input.spendPolicy ?? {};
  const card: RoomAgentCard = {
    room: {
      id: text(input.room.id).slice(0, 80),
      title: scrubValue(text(input.room.title, "未命名房間")).slice(0, 120),
      role: roleOf(text(input.room.role)),
    },
    contents: (input.contents ?? []).slice(0, MAX_CONTENTS).map((item) => ({
      branchId: text(item.branchId).slice(0, 80),
      type: contentType(text(item.type)),
      name: scrubValue(text(item.name, "未命名")).slice(0, 120),
      latestVersionLabel: scrubValue(text(item.latestVersionLabel, "最新")).slice(0, 80),
      openCommentCount: Math.max(0, Math.floor(item.openCommentCount ?? 0)),
    })),
    focus,
    comments,
    workLayer: input.workLayer
      ? {
          proposalId: text(input.workLayer.proposalId).slice(0, 80),
          status: text(input.workLayer.status, "draft").slice(0, 40),
          items: workItems(input.workLayer.items),
        }
      : undefined,
    allowedActions: [...ROOM_AGENT_TOOLS],
    spendPolicy: {
      maxUsdThisTurn: typeof spend.maxUsdThisTurn === "number" && spend.maxUsdThisTurn > 0
        ? spend.maxUsdThisTurn
        : DEFAULT_MAX_USD_PER_TURN,
      allowImagineImage: spend.allowImagineImage !== false,
      allowImagineVideo: spend.allowImagineVideo === true,
    },
    truncated,
  };
  return stripSecrets(card);
}

export function roomAgentCardLeaks(card: unknown): string[] {
  const leaks: string[] = [];
  const raw = JSON.stringify(card);
  if (INVITE_LEAK.test(raw) || /"invite"/i.test(raw)) leaks.push("invite");
  if (SERVICE_ROLE.test(raw)) leaks.push("service_role");
  if (DATA_URL.test(raw)) leaks.push("data_url");
  if (STORAGE_PATH.test(raw)) leaks.push("storage_path");
  return leaks;
}

export function grokTextModel(env: Record<string, string | undefined> = {}): string {
  const requested = (env.GROK_TEXT_MODEL || DEFAULT_GROK_TEXT_MODEL).trim();
  if (/grok-4\.6|grok-4-6|grok-4\.5|grok-4-5/i.test(requested)) return DEFAULT_GROK_TEXT_MODEL;
  return requested || DEFAULT_GROK_TEXT_MODEL;
}

export function roomAgentHealth(input: {
  provider?: string;
  xaiApiKey?: string;
  tkuZenAgentUrl?: string;
  sharedSecret?: string;
}): { configured: boolean; provider: string; copy?: string } {
  const provider = (input.provider || "tku-zen-agent").trim().toLowerCase();
  if (provider === "grok-room-agent") {
    if (!input.xaiApiKey?.trim()) {
      return { configured: false, provider, copy: AGENT_UNCONFIGURED_COPY };
    }
    return { configured: true, provider };
  }
  if (provider === "none" || provider === "") {
    return { configured: false, provider: "none", copy: AGENT_UNCONFIGURED_COPY };
  }
  if (!input.tkuZenAgentUrl?.trim() || !input.sharedSecret?.trim()) {
    return { configured: false, provider, copy: AGENT_UNCONFIGURED_COPY };
  }
  return { configured: true, provider };
}

export function estimateImagineVideoUsd(seconds: number, resolution = "720p"): number {
  const rate = IMAGINE_VIDEO_USD_PER_SEC[resolution] ?? IMAGINE_VIDEO_USD_PER_SEC["720p"];
  const secs = Math.max(1, Math.min(15, Math.floor(seconds)));
  return Math.round(secs * rate * 100) / 100;
}

export function spendWouldExceed(spentUsd: number, addUsd: number, maxUsd: number): boolean {
  return spentUsd + addUsd > maxUsd + 1e-9;
}

function refuse(tool: string, error: string, recorded = true): RoomAgentToolResult {
  return { ok: false, refused: true, recorded, tool, error };
}

function previewResult(tool: string, preview: string, extra: Partial<RoomAgentToolResult> = {}): RoomAgentToolResult {
  return { ok: true, tool, preview, proposalId: extra.proposalId ?? `proposal:${tool}`, ...extra };
}

export function dispatchRoomAgentTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: RoomAgentToolContext,
): RoomAgentToolResult {
  const spent = ctx.spentUsd ?? 0;
  const maxUsd = ctx.card.spendPolicy.maxUsdThisTurn;

  if ((ROOM_AGENT_FORBIDDEN_TOOLS as readonly string[]).includes(tool)) {
    return refuse(tool, "這個動作會改到原稿或越權，已拒絕並記錄。");
  }
  if (!(ROOM_AGENT_TOOLS as readonly string[]).includes(tool)) {
    return refuse(tool, "未知工具，已拒絕並記錄。");
  }

  if (tool === "list_room_contents") {
    return {
      ok: true,
      tool,
      preview: `房間有 ${ctx.card.contents.length} 份內容`,
      data: ctx.card.contents,
    };
  }
  if (tool === "get_version_brief") {
    const versionId = text(args.versionId);
    const content = ctx.card.contents.find((item) => item.branchId === ctx.card.focus?.branchId) ?? ctx.card.contents[0];
    const open = ctx.card.comments.filter((item) => !versionId || item.versionId === versionId).length;
    return {
      ok: true,
      tool,
      preview: `${ctx.card.focus?.label ?? content?.name ?? "內容"} · ${content?.latestVersionLabel ?? "最新"} · 未完成修改點 ${open}`,
      data: {
        versionId: versionId || ctx.card.focus?.versionId,
        label: ctx.card.focus?.label ?? content?.latestVersionLabel,
        width: ctx.card.focus?.width,
        height: ctx.card.focus?.height,
        openCommentCount: open,
        workLayer: ctx.card.workLayer ? { proposalId: ctx.card.workLayer.proposalId, status: ctx.card.workLayer.status, itemCount: ctx.card.workLayer.items.length } : undefined,
      },
    };
  }
  if (tool === "list_open_comments") {
    const branchId = text(args.branchId);
    const comments = ctx.card.comments.filter((item) => !branchId || item.versionId || true);
    return { ok: true, tool, preview: `未完成修改點 ${comments.length} 則`, data: comments };
  }
  if (tool === "propose_edit_text" || tool === "propose_add_shape" || tool === "propose_move_item" || tool === "propose_add_image") {
    const preview = tool === "propose_edit_text"
      ? `文字提案：${scrubValue(text(args.text) || text(args.role)).slice(0, 80) || "改文案"}`
      : tool === "propose_add_shape"
        ? "加上色塊／形狀（僅提案）"
        : tool === "propose_move_item"
          ? "移動工作層元件（僅提案）"
          : "加上圖片到工作層（僅提案）";
    return previewResult(tool, preview);
  }
  if (tool === "create_plan_draft") {
    return previewResult(tool, `企劃草稿提案：${scrubValue(text(args.title) || text(args.text)).slice(0, 80) || "未命名企劃"}`);
  }
  if (tool === "refuse_with_reason") {
    return { ok: true, tool, preview: scrubValue(text(args.reason, "這次做不到")).slice(0, 200) };
  }
  if (tool === "imagine_image") {
    if (!ctx.card.spendPolicy.allowImagineImage) {
      return refuse(tool, "這一回合不允許生圖。");
    }
    if (spendWouldExceed(spent, IMAGINE_IMAGE_USD, maxUsd)) {
      return refuse(tool, `這一回合花費上限 $${maxUsd.toFixed(2)}，生圖會超過，已停止。`);
    }
    return previewResult(tool, IMAGINE_NOT_VERSION_COPY, { spentUsd: spent + IMAGINE_IMAGE_USD });
  }
  if (tool === "imagine_video") {
    if (!ctx.imagineVideoConfirmed) {
      const seconds = typeof args.seconds === "number" ? args.seconds : 6;
      const resolution = text(args.resolution, "720p") || "720p";
      const cost = estimateImagineVideoUsd(seconds, resolution);
      return {
        ok: false,
        refused: true,
        recorded: true,
        tool,
        error: "生影前必須先確認估價。",
        preview: "生影前必須先確認估價。",
        data: {
          needsConfirm: true,
          seconds: Math.max(1, Math.min(15, Math.floor(seconds))),
          resolution,
          estimatedUsd: cost,
          prompt: text(args.prompt).slice(0, 400),
        },
      };
    }
    if (!ctx.card.spendPolicy.allowImagineVideo) {
      return refuse(tool, "這一回合不允許生影。");
    }
    const seconds = typeof args.seconds === "number" ? args.seconds : 6;
    const resolution = text(args.resolution, "720p") || "720p";
    const cost = estimateImagineVideoUsd(seconds, resolution);
    if (spendWouldExceed(spent, cost, maxUsd)) {
      return refuse(tool, `這一回合花費上限 $${maxUsd.toFixed(2)}，生影約 $${cost.toFixed(2)}，已停止。`);
    }
    return previewResult(tool, `已生成約 ${Math.max(1, Math.min(15, Math.floor(seconds)))} 秒短影預覽，尚未成為正式版本`, { spentUsd: spent + cost });
  }
  return refuse(tool, "未知工具，已拒絕並記錄。");
}

export function grokChatRequestBody(input: {
  query: string;
  card: RoomAgentCard;
  model?: string;
}): Record<string, unknown> {
  return {
    model: grokTextModel({ GROK_TEXT_MODEL: input.model }),
    stream: false,
    messages: [
      {
        role: "system",
        content: "你是對稿活動房的提案助手。只能讀這張房間卡片與白名單工具。AI 不是成員，不能代替主辦決定，不能覆寫 version 或 Storage。回覆繁中。禁止 web_search 與 x_search。",
      },
      {
        role: "user",
        content: JSON.stringify({ query: input.query.slice(0, 2000), card: input.card }),
      },
    ],
    tools: ROOM_AGENT_TOOLS.map((name) => ({
      type: "function",
      function: { name, description: name, parameters: { type: "object", additionalProperties: true } },
    })),
  };
}

export function grokRequestEnablesSearch(body: Record<string, unknown>): boolean {
  const raw = JSON.stringify(body);
  return /web_search|x_search/i.test(raw) && !/禁止 web_search/.test(raw);
}

export function parseGrokProviderPayload(
  data: unknown,
  contentType?: string | null,
): { ok: true; text: string; toolCalls: Array<{ name: string; args: Record<string, unknown> }> } | { ok: false; code: string } {
  const parsed = parseFunctionPayload(data, { contentType });
  if (parsed.kind === "reject") return { ok: false, code: parsed.code };
  const value = parsed.value;
  if (value.ok === true) {
    const nested = parseFunctionPayload(value, { successKeys: ["text"] });
    if (nested.kind === "reject") return { ok: false, code: nested.code };
  }
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const message = choices[0] && typeof choices[0] === "object"
    ? (choices[0] as { message?: { content?: unknown; tool_calls?: unknown } }).message
    : undefined;
  const answerText = typeof message?.content === "string"
    ? message.content
    : typeof value.text === "string"
      ? value.text
      : typeof value.answer === "string"
        ? value.answer
        : "";
  if (!answerText.trim() && !Array.isArray(message?.tool_calls)) {
    return { ok: false, code: "MISSING_KEYS" };
  }
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.flatMap((item) => {
        const row = item && typeof item === "object" ? item as { function?: { name?: string; arguments?: string } } : {};
        const name = text(row.function?.name);
        if (!name) return [];
        let args: Record<string, unknown> = {};
        try {
          args = row.function?.arguments ? JSON.parse(row.function.arguments) as Record<string, unknown> : {};
        } catch {
          args = {};
        }
        return [{ name, args }];
      })
    : [];
  return { ok: true, text: answerText.replace(/https?:\/\/[^\s)]+/gi, "[連結已省略]").slice(0, 5000), toolCalls };
}

export function actionsFromToolResults(results: RoomAgentToolResult[]): Array<{
  type: RoomAgentActionType;
  label: string;
  payload: Record<string, unknown>;
}> {
  return results.filter((item) => item.ok && item.tool !== "list_room_contents" && item.tool !== "get_version_brief" && item.tool !== "list_open_comments").slice(0, 6).map((item) => ({
    type: item.tool as RoomAgentActionType,
    label: item.preview || item.tool,
    payload: {
      proposalId: item.proposalId,
      preview: item.preview,
    },
  }));
}

/** 採用 visual 提案時不得改到舊 version 的 storage path。 */
export function applyMustNotChangeVersionStorage(
  beforePath: string | undefined,
  afterPath: string | undefined,
): boolean {
  return beforePath === afterPath;
}

export function isVisualProposeAction(type: string): boolean {
  return type === "propose_edit_text"
    || type === "propose_add_shape"
    || type === "propose_move_item"
    || type === "propose_add_image"
    || type === "imagine_image"
    || type === "imagine_video";
}
