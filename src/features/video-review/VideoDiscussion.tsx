import { useMemo, useState } from "react";
import {
  commentStatus,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABEL,
  VIDEO_CATEGORIES,
  type CommentPin,
  type ReviewStatus,
  type Room,
  type VideoCategory,
} from "../../lib/types";
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

/** 全部 plus the six video buckets. `null` means no filter at all. */
type CategoryFilter = VideoCategory | null;

export function VideoDiscussion({ api, versionId, selectedId, onSelect, compact }: Props) {
  const [sort, setSort] = useState<VideoSort>("time");
  const [category, setCategory] = useState<CategoryFilter>(null);
  const { room } = api;
  const canManage = api.video?.canManageReview ?? false;

  const all = useMemo(() => videoCommentsOf(room, versionId), [room, versionId]);

  const items = useMemo(() => {
    const filtered = category ? all.filter((c) => c.problemType === category) : all;
    return sortVideoComments(filtered, sort);
  }, [all, category, sort]);

  // Only offer a bucket somebody actually used: six dead chips on a phone is
  // six taps of disappointment.
  const usedCategories = useMemo(
    () => VIDEO_CATEGORIES.filter((cat) => all.some((c) => c.problemType === cat)),
    [all],
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

      {usedCategories.length > 0 && (
        <div className="v-catrow" role="tablist" aria-label="回饋分類">
          <button
            type="button"
            role="tab"
            aria-selected={category === null}
            className={`m-chip ${category === null ? "is-on" : ""}`}
            onClick={() => setCategory(null)}
          >
            全部
          </button>
          {usedCategories.map((cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={category === cat}
              className={`m-chip ${category === cat ? "is-on" : ""}`}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

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
          <div key={c.id} className="v-item">
            <CommentCard
              api={api}
              pin={c}
              compact={compact}
              selected={c.id === selectedId}
              anchorLabel={anchorLabel(c)}
              onSelect={() => onSelect(c)}
              onToggleResolve={() => api.toggleResolve(c.id)}
            />
            {/* The four-state is the AUTHOR's工作流. A reviewer keeps the plain
                完成 toggle the card already has and never sees this strip —
                which is also what the database enforces, so the UI is not the
                only thing standing between a reviewer and 「不採用」. */}
            {canManage && <StatusStrip api={api} pin={c} />}
          </div>
        ))}
      </div>
    </>
  );
}

/** 待處理 / 處理中 / 已修改 / 不採用 for one piece of feedback. */
function StatusStrip({ api, pin }: { api: WorkspaceApi; pin: CommentPin }) {
  const current = commentStatus(pin);
  return (
    <div className="v-status" role="group" aria-label={`這則回饋的處理狀態（目前：${REVIEW_STATUS_LABEL[current]}）`}>
      {REVIEW_STATUSES.map((status: ReviewStatus) => (
        <button
          key={status}
          type="button"
          className={`v-status-btn ${current === status ? "is-on" : ""}`}
          aria-pressed={current === status}
          onClick={() => api.video?.setStatus(pin.id, status)}
        >
          {REVIEW_STATUS_LABEL[status]}
        </button>
      ))}
    </div>
  );
}
