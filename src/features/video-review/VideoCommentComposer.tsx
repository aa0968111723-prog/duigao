import type { VideoAnchor } from "../../lib/types";
import { ModalSheet } from "../../components/BottomSheet";
import { PinFields } from "../discussion/PinFields";
import type { WorkspaceApi } from "../../components/api";
import { formatTime } from "./media";

/**
 * Writing feedback about a moment.
 *
 * Everything below the title is the poster app's composer, unchanged — quick
 * reasons, one sentence, the optional 補充. Re-inventing it would mean two
 * places to keep kind, and reviewers already know this form. The only thing
 * video adds is the line at the top saying *when* this is about.
 */

type Props = {
  api: WorkspaceApi;
  anchor: VideoAnchor;
  /** Back to the timeline to pick again, keeping whatever was typed. */
  onRepick?: () => void;
  onCancel: () => void;
  onSubmit: () => void;
};

export function anchorHeading(anchor: VideoAnchor): string {
  return anchor.kind === "range"
    ? `${formatTime(anchor.startTime)}–${formatTime(anchor.endTime)} 這一段`
    : `${formatTime(anchor.time)} 這一刻`;
}

export function VideoCommentComposer({ api, anchor, onRepick, onCancel, onSubmit }: Props) {
  const canSend = Boolean(api.form.body.trim());
  return (
    <ModalSheet
      title={anchorHeading(anchor)}
      onClose={onCancel}
      // Half-typed feedback must not vanish to a stray backdrop tap; Escape and
      // 關閉 still work, matching the poster composer exactly.
      dismissible={!canSend}
      action={
        <div className="m-compose-actions">
          {onRepick && (
            <button type="button" className="m-btn" onClick={onRepick}>
              重新選時間
            </button>
          )}
          <button
            type="button"
            className="m-btn m-btn-primary m-btn-block"
            onClick={onSubmit}
            disabled={!canSend}
          >
            送出
          </button>
        </div>
      }
    >
      <p className="v-compose-hint">
        {anchor.kind === "range"
          ? "這段哪裡需要調整？一句話就可以。"
          : "這個時間點哪裡需要調整？一句話就可以。"}
      </p>
      <PinFields api={api} autoFocus />
    </ModalSheet>
  );
}
