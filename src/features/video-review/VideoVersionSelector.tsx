import type { Version } from "../../lib/types";
import { UploadZone } from "../../components/UploadZone";
import { VIDEO_ACCEPT } from "./media";

/**
 * 初剪｜改一｜改二 — plus the one action that adds the next cut.
 *
 * Switching cuts keeps roughly the same moment (spec §20): the whole point of
 * comparing two versions is looking at the same beat twice, and being thrown
 * back to 0:00 every time makes that manual work. The clamp lives in the
 * workspace, which knows both durations; this component only reports the tap.
 */

type Props = {
  versions: Version[];
  currentId: string;
  onSelect: (versionId: string) => void;
  onAddFiles: (files: FileList | null) => void;
  /** Hidden while a cut is uploading: two in flight would race for sort_order. */
  canAdd: boolean;
};

export function VideoVersionSelector({ versions, currentId, onSelect, onAddFiles, canAdd }: Props) {
  return (
    <div className="m-versions">
      {versions.map((v) => (
        <button
          key={v.id}
          type="button"
          className={`m-vchip ${v.id === currentId ? "is-on" : ""}`}
          aria-pressed={v.id === currentId}
          onClick={() => onSelect(v.id)}
        >
          {v.label}
        </button>
      ))}
      {canAdd && (
        <UploadZone onFiles={onAddFiles} accept={VIDEO_ACCEPT} multiple={false} className="m-vchip m-vchip-add">
          <span aria-hidden>＋</span>
        </UploadZone>
      )}
    </div>
  );
}
