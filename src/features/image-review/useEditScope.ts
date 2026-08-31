import { useCallback, useMemo, useState } from "react";
import { AGENT_UNCONFIGURED_COPY } from "../../ai/roomAgentContract";
import {
  canGenerateEdit,
  chipCaption,
  editScopeInputFromWorkspace,
  inferEditScope,
  visualEditHint,
  type EditScope,
  type InferEditScopeResult,
  EMPTY_EDIT_SCOPE_COPY,
} from "../../ai/editScope";
import { applyVisualEditResult, invokeVisualEdit } from "../../ai/runVisualEdit";
import { useProposalStore } from "../visual-proposal/store";
import type { WorkspaceApi } from "../../components/api";

export function useEditScope(api: WorkspaceApi, versionId: string, cloudRoomId?: string | null) {
  const { room, guest, showToast } = api;
  const [override, setOverride] = useState<EditScope | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const proposal = useProposalStore(room.id, versionId, guest);

  const draft = api.draftPin?.versionId === versionId ? api.draftPin : null;
  const selected = room.comments.find((pin) => pin.id === api.selectedPinId && pin.versionId === versionId);
  const region = draft?.region ?? selected?.region;

  const scopeInput = useMemo(
    () => editScopeInputFromWorkspace({
      versionId,
      comments: room.comments,
      draftPin: api.draftPin,
      formBody: api.form.body,
      selectedPinId: api.selectedPinId,
      override,
    }),
    [api.draftPin, api.form.body, api.selectedPinId, override, room.comments, versionId],
  );

  const inferred: InferEditScopeResult = useMemo(
    () => inferEditScope(scopeInput),
    [scopeInput],
  );

  const generate = useCallback(async (forced?: EditScope) => {
    const nextInput = forced && forced !== override
      ? { ...scopeInput, override: forced }
      : scopeInput;
    const result = inferEditScope(nextInput);
    if (!canGenerateEdit(nextInput) || !result.scope) {
      setHint(EMPTY_EDIT_SCOPE_COPY);
      showToast(EMPTY_EDIT_SCOPE_COPY, { tone: "info" });
      return;
    }
    if (forced) setOverride(forced);
    setBusy(true);
    setHint("");
    try {
      const invoked = await invokeVisualEdit({
        roomId: cloudRoomId ?? room.id,
        versionId,
        scope: result.scope,
        label: result.label,
        bodyText: nextInput.bodyText ?? "",
      });
      if (!invoked.ok) {
        setHint(invoked.error);
        showToast(invoked.error, { tone: invoked.unconfigured ? "info" : "error" });
        return;
      }
      const version = room.versions.find((item) => item.id === versionId) ?? room.versions[0];
      if (!version) {
        setHint("還沒有可對照的版本。");
        return;
      }
      const applied = await applyVisualEditResult({
        roomId: room.id,
        cloudRoomId,
        version,
        scope: result.scope,
        label: result.label,
        bodyText: nextInput.bodyText ?? "",
        x: region ? region.x + region.width / 2 : (draft?.x ?? selected?.x ?? 0.5),
        y: region ? region.y + region.height / 2 : (draft?.y ?? selected?.y ?? 0.5),
        width: result.scope === "full" ? 100 : region ? Math.max(18, region.width * 100) : 40,
        authorName: guest.name,
        path: invoked.path,
        proposalId: invoked.proposalId,
      });
      if (!applied.ok) {
        setHint(applied.error);
        showToast(applied.error, { tone: "error" });
        return;
      }
      proposal.setViewMode(result.scope === "full" ? "compare" : "proposal");
      const toast = visualEditHint(result.scope);
      setHint(toast);
      showToast(toast, { tone: "success" });
    } finally {
      setBusy(false);
    }
  }, [cloudRoomId, draft, guest.name, override, proposal, region, room.id, room.versions, scopeInput, selected, showToast, versionId]);

  return {
    inferred,
    override,
    setOverride,
    generate,
    busy,
    hint,
    caption: chipCaption(inferred),
    emptyCopy: EMPTY_EDIT_SCOPE_COPY,
    unconfiguredCopy: AGENT_UNCONFIGURED_COPY,
  };
}
