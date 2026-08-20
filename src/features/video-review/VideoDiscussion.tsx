import { useMemo, useState } from "react";
import type { CommentPin, Room } from "../../lib/types";
import { CommentCard } from "../discussion/CommentCard";
import type { WorkspaceApi } from "../../components/api";
import { anchorLabel, anchorStart, isVideoComment } from "./anchors";

/**
 * The discussion, read against a video.
 *
 * Same cards, same 我也覺得, same replies as poster review — the only thing that
 * changes is what a comment is *about*, so time leads every card and the
 * default order is the order the video plays in (spec §18): a reviewer walking
 * the cut top to bottom is the whole job.
 */

export type VideoSort = "time" | "latest" | "open" | "done";

const SORTS: { id: VideoSort; label: string }[] = [
  { id: "time", label: "依時間" },
  { id: "latest", label: "最新" },
  { id: "open", label: "待修改" },
  { id: "done", label: "已完成" },
];

type Props = {
  api: WorkspaceApi;
  /** Only this version's feedback: 初剪 00:13 and 改一 00:13 are different moments. */
  versionId: string;
  selectedId: string | null;
  onSelect: (pin: CommentPin) => void;
  compact?: boolean;
};

export function videoCommentsOf(room: Room, versionId: string): CommentPin[] {
  return room.comments.filter((c) => c.versionId === versionId && isVideoComment(c));
}

export function sortVideoComments(list: CommentPin[], sort: VideoSort): CommentPin[] {
  const copy = [...list];
  switch (sort) {
    case "latest":
      return copy.sort((a, b) => b.createdAt - a.createdAt);
    case "open":
      return copy.filter((c) => !c.resolved).sort((a, b) => anchorStart(a) - anchorStart(b));
    case "done":
      return copy.filter((c) => c.resolved).sort((a, b) => anchorStart(a) - anchorStart(b));
    default:
      // Ties keep insertion order, so two notes on the same frame read in the
      // order they were written rather than jumping around between renders.
      return copy.sort((a, b) => anchorStart(a) - anchorStart(b) || a.createdAt - b.createdAt);
  }
}

export function VideoDiscussion({ api, versionId, selectedId, onSelect, compact }: Props) {
  const [sort, setSort] = useState<VideoSort>("time");
  const { room } = api;

  const items = useMemo(
    () => sortVideoComments(videoCommentsOf(room, versionId), sort),
    [room, versionId, sort],
  );

  return (
    <>
      <div className="v-sortrow" role="tablist" aria-label="討論排序">
        {SORTS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={sort === s.id}
            className={`m-chip ${sort === s.id ? "is-on" : ""}`}
            onClick={() => setSort(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="m-list">
        {items.length === 0 && (
          <div className="m-discuss-empty">
            <p className="m-discuss-empty-title">
              {sort === "done" ? "還沒有完成的項目" : sort === "open" ? "沒有待修改的項目" : "還沒有討論"}
            </p>
            <p className="m-discuss-empty-sub">
              播到覺得怪怪的地方，
              <br />
              {compact ? "按「修改」留一句就可以。" : "按「這一刻留意見」留一句就可以。"}
            </p>
          </div>
        )}
        {items.map((c) => (
          <CommentCard
            key={c.id}
            api={api}
            pin={c}
            compact={compact}
            selected={c.id === selectedId}
            anchorLabel={anchorLabel(c)}
            onSelect={() => onSelect(c)}
            onToggleResolve={() => api.toggleResolve(c.id)}
          />
        ))}
      </div>
    </>
  );
}
