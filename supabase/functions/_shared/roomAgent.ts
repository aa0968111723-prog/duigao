/**
 * Edge-side Grok room agent. Tool names and refuse rules match
 * src/ai/roomAgentContract.ts. Card is bounded 繁中; secrets stay stripped.
 */
import { asObject, asText, jsonResponse, stripSecrets } from "./roomContext.ts";
import { executeImagineImage, executeImagineVideo, type ImagineFetch } from "./imagine.ts";

export const GROK_PROVIDER = "grok-room-agent";
export const DEFAULT_GROK_TEXT_MODEL = "grok-4-1-fast-non-reasoning";
export const DEFAULT_GROK_IMAGE_MODEL = "grok-imagine-image";
export const DEFAULT_GROK_VIDEO_MODEL = "grok-imagine-video";
export const DEFAULT_MAX_USD = 0.05;
export const IMAGINE_IMAGE_USD = 0.02;
export const AGENT_UNCONFIGURED_COPY = "AI 服務尚未設定";
export const IMAGINE_NOT_VERSION_COPY = "已生成一張圖，尚未成為正式版本";

export const ALLOWED_TOOLS = [
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

export const FORBIDDEN_TOOLS = [
  "overwrite_version",
  "delete_version",
  "delete_branch",
  "replace_storage_object",
  "send_as_member",
  "expose_invite",
  "expose_service_role",
] as const;

const ALLOWED_SET = new Set<string>(ALLOWED_TOOLS);
const FORBIDDEN_SET = new Set<string>(FORBIDDEN_TOOLS);

export type GrokEnv = {
  provider: string;
  xaiKey: string;
  textModel: string;
  imageModel: string;
  videoModel: string;
  maxUsd: number;
};

export function grokEnv(): GrokEnv | null {
  const provider = (Deno.env.get("DUIGAO_AGENT_PROVIDER") || "tku-zen-agent").trim().toLowerCase();
  if (provider !== GROK_PROVIDER) return null;
  const xaiKey = (Deno.env.get("XAI_API_KEY") || "").trim();
  if (!xaiKey) return null;
  const textModel = (Deno.env.get("GROK_TEXT_MODEL") || DEFAULT_GROK_TEXT_MODEL).trim();
  const safeModel = /grok-4\.6|grok-4-6|grok-4\.5|grok-4-5/i.test(textModel) ? DEFAULT_GROK_TEXT_MODEL : (textModel || DEFAULT_GROK_TEXT_MODEL);
  const maxRaw = Number(Deno.env.get("DUIGAO_AGENT_MAX_USD_PER_TURN") || DEFAULT_MAX_USD);
  return {
    provider: GROK_PROVIDER,
    xaiKey,
    textModel: safeModel,
    imageModel: (Deno.env.get("GROK_IMAGE_MODEL") || DEFAULT_GROK_IMAGE_MODEL).trim(),
    videoModel: (Deno.env.get("GROK_VIDEO_MODEL") || DEFAULT_GROK_VIDEO_MODEL).trim(),
    maxUsd: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : DEFAULT_MAX_USD,
  };
}

export function grokUnconfigured(): boolean {
  const provider = (Deno.env.get("DUIGAO_AGENT_PROVIDER") || "tku-zen-agent").trim().toLowerCase();
  if (provider !== GROK_PROVIDER) return false;
  return !(Deno.env.get("XAI_API_KEY") || "").trim();
}

export type AgentCard = {
  room: { id: string; title: string; role: string };
  contents: Array<{ branchId: string; type: string; name: string; latestVersionLabel: string; openCommentCount: number }>;
  focus?: {
    branchId?: string;
    versionId?: string;
    label: string;
    width?: number;
    height?: number;
    thumbnail?: { kind: string; value: string };
    nodeId?: string;
    nodeType?: string;
    source?: "discussion" | "version" | "schedule" | "none";
    treePath?: string;
    treeRootId?: string;
  };
  comments: Array<{ id: string; versionId?: string; body: string; regionSummary?: string }>;
  workLayer?: { proposalId: string; status: string; items: Array<{ id: string; type: string; role?: string; text?: string; approxPosition?: string }> };
  allowedActions: string[];
  spendPolicy: { maxUsdThisTurn: number; allowImagineImage: boolean; allowImagineVideo: boolean };
  truncated: boolean;
};

export function buildCard(input: {
  roomId: string;
  title: string;
  role: string;
  contents: AgentCard["contents"];
  focus?: AgentCard["focus"];
  comments: AgentCard["comments"];
  workLayer?: AgentCard["workLayer"];
  truncated: boolean;
  maxUsd: number;
  allowImagineVideo: boolean;
}): AgentCard {
  return stripSecrets({
    room: { id: input.roomId, title: input.title.slice(0, 120), role: input.role },
    contents: input.contents.slice(0, 24),
    focus: input.focus,
    comments: input.comments.filter((item) => item.body).slice(0, 8),
    workLayer: input.workLayer
      ? {
          proposalId: input.workLayer.proposalId,
          status: input.workLayer.status,
          items: input.workLayer.items.map((item) => ({
            id: item.id,
            type: item.type,
            role: item.role,
            text: item.text,
            approxPosition: item.approxPosition,
          })).slice(0, 12),
        }
      : undefined,
    allowedActions: [...ALLOWED_TOOLS],
    spendPolicy: {
      maxUsdThisTurn: input.maxUsd,
      allowImagineImage: true,
      allowImagineVideo: input.allowImagineVideo,
    },
    truncated: input.truncated,
  });
}

type ToolOut = {
  name: string;
  preview: string;
  refused?: boolean;
  recorded?: boolean;
  proposalId?: string;
  needsConfirm?: boolean;
  seconds?: number;
  resolution?: string;
  estimatedUsd?: number;
  prompt?: string;
};

export function runTool(
  name: string,
  args: Record<string, unknown>,
  card: AgentCard,
  confirmedVideo: boolean,
  spentUsd: number,
): { result: ToolOut; spentUsd: number } {
  if (FORBIDDEN_SET.has(name)) {
    return { result: { name, preview: "這個動作會改到原稿或越權，已拒絕並記錄。", refused: true, recorded: true }, spentUsd };
  }
  if (!ALLOWED_SET.has(name)) {
    return { result: { name, preview: "未知工具，已拒絕並記錄。", refused: true, recorded: true }, spentUsd };
  }
  if (name === "list_room_contents") {
    return { result: { name, preview: `房間有 ${card.contents.length} 份內容` }, spentUsd };
  }
  if (name === "get_version_brief") {
    return { result: { name, preview: `${card.focus?.label ?? card.contents[0]?.name ?? "內容"} · 未完成修改點 ${card.comments.length}` }, spentUsd };
  }
  if (name === "list_open_comments") {
    return { result: { name, preview: `未完成修改點 ${card.comments.length} 則` }, spentUsd };
  }
  if (name === "imagine_video") {
    const seconds = Math.max(1, Math.min(15, Math.floor(typeof args.seconds === "number" ? args.seconds : 6)));
    const resolution = asText(args.resolution, "720p") === "480p" ? "480p" : "720p";
    const rate = resolution === "480p" ? 0.05 : 0.07;
    const cost = Math.round(seconds * rate * 100) / 100;
    if (!confirmedVideo) {
      return {
        result: {
          name,
          preview: "生影前必須先確認估價。",
          refused: true,
          recorded: true,
          needsConfirm: true,
          seconds,
          resolution,
          estimatedUsd: cost,
          prompt: asText(args.prompt).slice(0, 400),
        },
        spentUsd,
      };
    }
    if (spentUsd + cost > card.spendPolicy.maxUsdThisTurn) {
      return { result: { name, preview: `這一回合花費上限 $${card.spendPolicy.maxUsdThisTurn.toFixed(2)}，生影約 $${cost.toFixed(2)}，已停止。`, refused: true, recorded: true }, spentUsd };
    }
    return { result: { name, preview: "已生成短影預覽，尚未成為正式版本", proposalId: "proposal:imagine_video" }, spentUsd: spentUsd + cost };
  }
  if (name === "imagine_image") {
    if (spentUsd + IMAGINE_IMAGE_USD > card.spendPolicy.maxUsdThisTurn) {
      return { result: { name, preview: `這一回合花費上限 $${card.spendPolicy.maxUsdThisTurn.toFixed(2)}，生圖會超過，已停止。`, refused: true, recorded: true }, spentUsd };
    }
    return { result: { name, preview: IMAGINE_NOT_VERSION_COPY, proposalId: "proposal:imagine_image" }, spentUsd: spentUsd + IMAGINE_IMAGE_USD };
  }
  return { result: { name, preview: asText(args.text || args.title || args.reason, name).slice(0, 120), proposalId: `proposal:${name}` }, spentUsd };
}

function looksLikeHtml(body: string, contentType: string | null): boolean {
  if (contentType && /text\/html/i.test(contentType)) return true;
  return /^\s*<(!doctype\s+html|html[\s>])/i.test(body);
}

export async function askGrok(input: {
  env: GrokEnv;
  query: string;
  card: AgentCard;
  imagineVideoConfirmed: boolean;
  fetchFn?: ImagineFetch;
  storeImagine?: (input: { bytes: Uint8Array; mime: string; kind: "image" | "video" }) => Promise<{ proposalId: string; path: string } | null>;
}): Promise<{ text: string; actions: Array<{ type: string; label: string; payload: Record<string, unknown> }>; model: string } | null> {
  const fetchFn = input.fetchFn ?? (fetch as ImagineFetch);
  const body = JSON.stringify({
    model: input.env.textModel,
    stream: false,
    messages: [
      {
        role: "system",
        content: input.imagineVideoConfirmed
          ? "你是對稿活動房的提案助手。只能讀這張房間卡片與白名單工具。AI 不是成員。禁止覆寫 version / Storage。回覆繁中。禁止 web_search 與 x_search。使用者已確認生影估價，若要生影請呼叫 imagine_video。"
          : "你是對稿活動房的提案助手。只能讀這張房間卡片與白名單工具。AI 不是成員。禁止覆寫 version / Storage。若 card.focus.treePath 存在，對準那條招生樹路徑說話。回覆繁中。禁止 web_search 與 x_search。生影必須先估價：呼叫 imagine_video 會得到估價卡，使用者確認後才生成。",
      },
      { role: "user", content: JSON.stringify({ query: input.query.slice(0, 2000), card: input.card }) },
    ],
    tools: ALLOWED_TOOLS.map((name) => ({
      type: "function",
      function: { name, description: name, parameters: { type: "object", additionalProperties: true } },
    })),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetchFn("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.env.xaiKey}`,
      },
      body,
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type");
    const rawText = await response.text();
    if (looksLikeHtml(rawText, contentType)) return null;
    let raw: Record<string, unknown>;
    try { raw = asObject(JSON.parse(rawText)); } catch { return null; }
    const choices = Array.isArray(raw.choices) ? raw.choices : [];
    const message = asObject(asObject(choices[0]).message);
    const text = asText(message.content) || asText(raw.text) || asText(raw.answer);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const actions: Array<{ type: string; label: string; payload: Record<string, unknown> }> = [];
    let spent = 0;
    const logs: string[] = [];
    for (const call of toolCalls.slice(0, 6)) {
      const fn = asObject(asObject(call).function);
      const name = asText(fn.name);
      let args: Record<string, unknown> = {};
      try { args = asObject(JSON.parse(asText(fn.arguments, "{}"))); } catch { args = {}; }
      const ran = runTool(name, args, input.card, input.imagineVideoConfirmed, spent);
      spent = ran.spentUsd;
      logs.push(`${name}:${ran.result.refused ? "refuse" : "ok"}`);
      if (name === "imagine_video" && ran.result.refused && ran.result.needsConfirm && !input.imagineVideoConfirmed) {
        actions.push({
          type: name,
          label: ran.result.preview,
          payload: stripSecrets({
            needsConfirm: true,
            seconds: ran.result.seconds,
            resolution: ran.result.resolution,
            estimatedUsd: ran.result.estimatedUsd,
            prompt: ran.result.prompt,
            preview: ran.result.preview,
          }),
        });
        continue;
      }
      if (ran.result.refused || name === "list_room_contents" || name === "get_version_brief" || name === "list_open_comments") continue;
      if (name === "imagine_image" || name === "imagine_video") {
        const generated = name === "imagine_image"
          ? await executeImagineImage({
            prompt: asText(args.prompt),
            size: asText(args.size) || undefined,
            model: input.env.imageModel,
            apiKey: input.env.xaiKey,
            fetchFn,
          })
          : await executeImagineVideo({
            prompt: asText(args.prompt),
            seconds: typeof args.seconds === "number" ? args.seconds : 6,
            resolution: asText(args.resolution) || undefined,
            model: input.env.videoModel,
            apiKey: input.env.xaiKey,
            confirmed: input.imagineVideoConfirmed,
            fetchFn,
          });
        if (!generated.ok) {
          logs.push(`${name}:imagine-fail`);
          continue;
        }
        const stored = input.storeImagine
          ? await input.storeImagine({
            bytes: generated.bytes,
            mime: generated.mime,
            kind: name === "imagine_video" ? "video" : "image",
          })
          : null;
        if (!stored || /\/versions\//.test(stored.path)) {
          logs.push(`${name}:store-fail`);
          continue;
        }
        actions.push({
          type: name,
          label: ran.result.preview,
          payload: stripSecrets({
            proposalId: stored.proposalId,
            preview: ran.result.preview,
            workLayerRef: stored.path,
          }),
        });
        continue;
      }
      actions.push({
        type: name,
        label: ran.result.preview,
        payload: stripSecrets({ proposalId: ran.result.proposalId, preview: ran.result.preview }),
      });
    }
    console.log(JSON.stringify({ roomAgent: "grok", tools: logs, spentUsd: spent, model: input.env.textModel }));
    const answer = (text || (actions.length ? "這是可審核的提案，採用後才會寫入工作層。" : "")).replace(/https?:\/\/[^\s)]+/gi, "[連結已省略]").slice(0, 5000);
    if (!answer) return null;
    return { text: answer, actions: actions.slice(0, 6), model: input.env.textModel };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export { jsonResponse };
