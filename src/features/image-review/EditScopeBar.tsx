import type { EditScope, InferEditScopeResult } from "../../ai/editScope";
import { EMPTY_EDIT_SCOPE_COPY } from "../../ai/editScope";
import "./editScope.css";

type Props = {
  inferred: InferEditScopeResult;
  override: EditScope | null;
  onOverride: (scope: EditScope | null) => void;
  onGenerate: (forced?: EditScope) => void;
  busy?: boolean;
  hint?: string;
  caption: string;
};

export function EditScopeBar({ inferred, override, onOverride, onGenerate, busy, hint, caption }: Props) {
  const scope = inferred.scope;
  const flip = scope === "full" ? "single" : "full";
  const flipLabel = scope === "full" ? "改判單一素材" : "改判整張";

  return (
    <div className="edit-scope-bar" data-testid="edit-scope-bar">
      <p className="edit-scope-caption">{caption}</p>
      {scope ? (
        <div className="edit-scope-row">
          <span className="edit-scope-chip" data-testid="edit-scope-chip" data-scope={scope}>{scope}</span>
          <button
            type="button"
            className="edit-scope-flip"
            data-testid="edit-scope-flip"
            disabled={busy}
            onClick={() => onOverride(override === flip ? null : flip)}
          >
            {flipLabel}
          </button>
          <button
            type="button"
            className="edit-scope-generate"
            data-testid="edit-scope-generate"
            disabled={busy}
            onClick={() => onGenerate()}
          >
            {busy ? "生成中…" : "依此生成"}
          </button>
        </div>
      ) : (
        <div className="edit-scope-row">
          <button type="button" className="edit-scope-flip" data-testid="edit-scope-flip" onClick={() => onOverride("full")}>
            改判整張
          </button>
          <button
            type="button"
            className="edit-scope-generate"
            data-testid="edit-scope-generate"
            disabled={busy}
            onClick={() => onGenerate()}
          >
            依此生成
          </button>
        </div>
      )}
      {hint ? <p className="edit-scope-hint" role="status">{hint}</p> : null}
      {!scope && !hint ? <p className="edit-scope-hint">{EMPTY_EDIT_SCOPE_COPY}</p> : null}
    </div>
  );
}
