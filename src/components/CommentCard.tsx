import type { CommentPin, Room } from "../lib/types";
import { pinNumber, versionLabel } from "./api";

type Props = {
  room: Room;
  pin: CommentPin;
  selected?: boolean;
  compact?: boolean;
  onSelect?: () => void;
  onToggleResolve: () => void;
};

/**
 * One review item. On phones only number / problem / status / author are shown;
 * type, priority and the suggestion stay secondary so the list scans fast.
 */
export function CommentCard({ room, pin, selected, compact, onSelect, onToggleResolve }: Props) {
  const n = pinNumber(room, pin.id);
  const label = versionLabel(room, pin.versionId);

  return (
    <article
      className={`m-item ${pin.resolved ? "is-done" : ""} ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      id={`pin-card-${pin.id}`}
    >
      <div className="m-item-top">
        <span className={`m-item-no ${pin.resolved ? "is-done" : ""}`}>{pin.resolved ? "✓" : n}</span>
        <p className="m-item-body">{pin.body}</p>
      </div>
      <div className="m-item-meta">
        <span className="m-item-who" style={{ color: pin.authorColor }}>
          {pin.authorName}
        </span>
        {label && <span>{label}</span>}
        {pin.priority && pin.priority !== "一般" && <span className="m-item-urgent">{pin.priority}</span>}
        {!compact && pin.problemType && <span>{pin.problemType}</span>}
        <button
          type="button"
          className={`m-item-state ${pin.resolved ? "is-done" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleResolve();
          }}
        >
          {pin.resolved ? "重新開啟" : "標記完成"}
        </button>
      </div>
      {pin.suggestion && <p className="m-item-suggestion">建議：{pin.suggestion}</p>}
    </article>
  );
}
