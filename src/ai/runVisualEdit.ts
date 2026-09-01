import { parseFunctionPayload } from "../cloud/apiResponse";
import { getSupabase } from "../cloud/client";
import { upsertProposal } from "../cloud/roomRepository";
import { applyCloudProposals } from "../features/visual-proposal/store";
import { AGENT_UNCONFIGURED_COPY, applyMustNotChangeVersionStorage } from "./roomAgentContract";
import { applyVisualWorkLayer, visualProposalFromCloud } from "./applyVisualWorkLayer";
import type { EditScope } from "./editScope";
import { visualEditHint } from "./editScope";
import type { AiProposal } from "./proposals";
import type { Version } from "../lib/types";

export type VisualEditRequest = {
  roomId: string;
  cloudRoomId?: string | null;
  version: Pick<Version, "id" | "imagePath" | "videoPath">;
  scope: EditScope;
  label: string;
  bodyText: string;
  x?: number;
  y?: number;
  width?: number;
  authorName: string;
};

export type VisualEditResult =
  | { ok: true; hint: string; proposalId: string; path: string; versionImagePath?: string }
  | { ok: false; error: string; unconfigured?: boolean };

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function invokeVisualEdit(input: {
  roomId: string;
  versionId: string;
  scope: EditScope;
  label: string;
  bodyText: string;
}): Promise<VisualEditResult> {
  const supabase = getSupabase();
  if (!supabase || !isUuid(input.roomId) || !isUuid(input.versionId)) {
    return { ok: false, error: AGENT_UNCONFIGURED_COPY, unconfigured: true };
  }
  const { data, error } = await supabase.functions.invoke("room-ai-context", {
    body: {
      roomId: input.roomId,
      visualEdit: {
        versionId: input.versionId,
        scope: input.scope,
        label: input.label,
        bodyText: input.bodyText,
      },
    },
  });
  if (error) return { ok: false, error: "視覺生成暫時沒有回應，請稍後再試。" };
  const parsed = parseFunctionPayload(data);
  if (parsed.kind === "reject") return { ok: false, error: "視覺生成暫時沒有回應，請稍後再試。" };
  const value = parsed.value;
  const agent = value.agent && typeof value.agent === "object" ? value.agent as { status?: string; message?: string } : {};
  if (agent.status === "unconfigured") {
    return { ok: false, error: typeof agent.message === "string" && agent.message.trim() ? agent.message : AGENT_UNCONFIGURED_COPY, unconfigured: true };
  }
  const answer = value.answer && typeof value.answer === "object"
    ? value.answer as { actions?: Array<{ type?: string; payload?: Record<string, unknown> }> }
    : {};
  const action = (answer.actions ?? []).find((item) => item.type === "imagine_image");
  const payload = action?.payload ?? {};
  const path = typeof payload.workLayerRef === "string" ? payload.workLayerRef : "";
  const proposalId = typeof payload.proposalId === "string" ? payload.proposalId : "";
  if (!path || /\/versions\//.test(path) || !proposalId) {
    return { ok: false, error: "視覺生成沒有落到工作層。" };
  }
  return { ok: true, hint: visualEditHint(input.scope), proposalId, path };
}

export async function applyVisualEditResult(input: VisualEditRequest & { path: string; proposalId: string }): Promise<VisualEditResult> {
  const hint = visualEditHint(input.scope);
  const proposal: AiProposal = {
    id: `imagine-edit-${input.proposalId.slice(0, 8)}`,
    type: "imagine_image",
    label: input.scope === "full" ? "第二版預覽" : `改 ${input.label}`.slice(0, 80),
    requiresExtraConfirm: false,
    source: "agent",
    payload: {
      proposalId: input.proposalId,
      workLayerRef: input.path,
      preview: hint,
      scope: input.scope,
      x: input.x,
      y: input.y,
      width: input.width ?? (input.scope === "full" ? 100 : 40),
    },
  };
  const before = input.version.imagePath;
  const applied = await applyVisualWorkLayer({
    proposal,
    version: { id: input.version.id, imagePath: input.version.imagePath, videoPath: input.version.videoPath },
    roomId: input.cloudRoomId ?? input.roomId,
    authorName: input.authorName,
    upsert: async (roomId, cloudProposal) => {
      const supabase = getSupabase();
      if (input.cloudRoomId && supabase && isUuid(input.cloudRoomId)) {
        const revision = await upsertProposal(supabase, input.cloudRoomId, cloudProposal);
        const visual = visualProposalFromCloud({ ...cloudProposal, revision });
        if (visual) applyCloudProposals(input.cloudRoomId, [visual]);
        return revision;
      }
      const visual = visualProposalFromCloud(cloudProposal);
      if (visual) applyCloudProposals(roomId, [visual]);
      return cloudProposal.revision + 1;
    },
  });
  if (!applyMustNotChangeVersionStorage(before, applied.versionImagePath)) {
    return { ok: false, error: "採用不能改到原稿路徑。" };
  }
  return { ok: true, hint, proposalId: input.proposalId, path: input.path, versionImagePath: applied.versionImagePath };
}
