import type { ProposalItem } from "./store";

type Tool = "move" | "crop";

type Props = {
  item: ProposalItem;
  tool: Tool;
  cropping: boolean;
  onTool: (tool: Tool) => void;
  onRotate: (delta: number) => void;
  onCenter: (axis: "x" | "y") => void;
  onReplace: () => void;
  onDelete: () => void;
  onCropConfirm: () => void;
  onCropCancel: () => void;
  onNudgeStart: (dx: number, dy: number) => void;
  onNudgeEnd: () => void;
};

export function QuickEditBar({
  item,
  tool,
  cropping,
  onTool,
  onRotate,
  onCenter,
  onReplace,
  onDelete,
  onCropConfirm,
  onCropCancel,
  onNudgeStart,
  onNudgeEnd,
}: Props) {
  const left = `${Math.min(0.92, Math.max(0.08, item.x)) * 100}%`;
  const top = `${item.y * 100}%`;
  const above = item.y > 0.62;
  if (cropping) {
    return (
      <div
        className={`quick-edit-bar ${above ? "is-above" : ""}`}
        data-testid="quick-edit-bar"
        style={{ left, top }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="quick-edit-primary" onClick={onCropConfirm}>確認裁剪</button>
        <button type="button" onClick={onCropCancel}>取消</button>
      </div>
    );
  }
  return (
    <div
      className={`quick-edit-bar ${above ? "is-above" : ""}`}
      data-testid="quick-edit-bar"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button type="button" className={tool === "move" ? "is-on" : ""} onClick={() => onTool("move")}>移動</button>
      {item.type === "image" && (
        <button type="button" className={tool === "crop" ? "is-on" : ""} onClick={() => onTool("crop")}>裁剪</button>
      )}
      {tool === "move" && (
        <>
          <NudgeButton label="左移" onStart={() => onNudgeStart(-1, 0)} onEnd={onNudgeEnd}>←</NudgeButton>
          <NudgeButton label="右移" onStart={() => onNudgeStart(1, 0)} onEnd={onNudgeEnd}>→</NudgeButton>
          <NudgeButton label="上移" onStart={() => onNudgeStart(0, -1)} onEnd={onNudgeEnd}>↑</NudgeButton>
          <NudgeButton label="下移" onStart={() => onNudgeStart(0, 1)} onEnd={onNudgeEnd}>↓</NudgeButton>
        </>
      )}
      {(item.type === "image" || item.type === "text") && (
        <>
          <button type="button" onClick={() => onRotate(-15)}>−15°</button>
          <button type="button" onClick={() => onRotate(15)}>+15°</button>
        </>
      )}
      {item.type === "image" && (
        <button type="button" onClick={onReplace}>換圖</button>
      )}
      <button type="button" onClick={() => onCenter("x")}>水平置中</button>
      <button type="button" onClick={() => onCenter("y")}>垂直置中</button>
      <button type="button" onClick={onDelete}>刪除</button>
    </div>
  );
}

function NudgeButton({
  label,
  onStart,
  onEnd,
  children,
}: {
  label: string;
  onStart: () => void;
  onEnd: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        onStart();
      }}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
    >
      {children}
    </button>
  );
}
