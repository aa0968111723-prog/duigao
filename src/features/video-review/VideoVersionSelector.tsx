import { activeVersions, type Version } from "../../lib/types";
import { UniversalIntake } from "../../components/UniversalIntake";

/**
 * 初剪｜改一｜改二 — plus the one action that adds the next cut.
 *
 * Switching cuts keeps roughly the same moment (spec §20). Archive lives here
 * so a discussed cut can leave the picker without deleting its history.
 */

type Props = {
  versions: Version[];
  currentId: string;
  onSelect: (versionId: string) => void;
  onAddFiles: (files: FileList | null) => void;
  /** Hidden while a cut is uploading: two in flight would race for sort_order. */
  canAdd: boolean;
  canArchive?: boolean;
  onArchive?: (versionId: string) => void;
  onRestore?: (versionId: string) => void;
  compareMode?: boolean;
  compareId?: string;
  onToggleCompare?: (versionId: string) => void;
};

export function VideoVersionSelector({
  versions,
  currentId,
  onSelect,
  onAddFiles,
  canAdd,
  canArchive,
  onArchive,
  onRestore,
  compareMode,
  compareId,
  onToggleCompare,
}: Props) {
  const visible = activeVersions(versions);
  const archived = versions.filter((version) => version.archivedAt);
  const showArchived = archived.length > 0;

  return (
    <div className="m-versions">
      {visible.map((v) => (
        <span key={v.id} className="m-vchip-wrap">
          <button
            type="button"
            className={`m-vchip ${v.id === currentId ? "is-on" : ""} ${compareMode && v.id === compareId ? "is-compare" : ""}`}
            aria-pressed={v.id === currentId}
            onClick={() => onSelect(v.id)}
          >
            {v.label}
          </button>
          {canArchive && onArchive && v.id === currentId && visible.length > 1 && (
            <button
              type="button"
              className="m-vchip-archive"
              aria-label={`封存 ${v.label}`}
              onClick={() => onArchive(v.id)}
            >
              封存
            </button>
          )}
          {onToggleCompare && v.id !== currentId && (
            <button
              type="button"
              className={`m-vchip-compare ${compareMode && compareId === v.id ? "is-on" : ""}`}
              aria-pressed={compareMode && compareId === v.id}
              onClick={() => onToggleCompare(v.id)}
            >
              比較
            </button>
          )}
        </span>
      ))}
      {showArchived && (
        <details className="m-vchip-archived">
          <summary>已封存 {archived.length}</summary>
          {archived.map((v) => (
            <span key={v.id} className="m-vchip-wrap">
              <button
                type="button"
                className={`m-vchip ${v.id === currentId ? "is-on" : ""}`}
                onClick={() => onSelect(v.id)}
              >
                {v.label}
              </button>
              {canArchive && onRestore && (
                <button type="button" className="m-vchip-archive" onClick={() => onRestore(v.id)}>
                  取消封存
                </button>
              )}
            </span>
          ))}
        </details>
      )}
      {canAdd && (
        <UniversalIntake profile="video" mode="zone" onFiles={onAddFiles} className="m-vchip m-vchip-add">
          <span aria-hidden>＋</span>
        </UniversalIntake>
      )}
    </div>
  );
}
