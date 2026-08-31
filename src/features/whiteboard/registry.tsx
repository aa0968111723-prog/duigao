/**
 * Node renderer 註冊表（WB02，任務書 §12）。
 *
 * 型別分支從 NodeView 的 if 鏈收斂到單一註冊表：新增 node 型別 =
 * 註冊一個 renderer，UI 零條件分支散落。未知型別（DB 詞彙比 client
 * 新）走誠實 fallback 卡，不炸畫面。
 *
 * text 節點的關鍵行為變更（audit §2 [major] 的根治）：textarea 只在
 * **editing 時**渲染 — 非編輯時是靜態文字層，整卡可拖、可點選；
 * 點兩下才進編輯（pointer 雙擊由手勢層供給）。
 */
import type { ReactNode } from "react";
import { formatVideoRange } from "../collaboration/nodes";
import { stickyTextInputProps } from "../collaboration/permissions";
import type { NodeType, WhiteboardNode } from "../collaboration/types";
import { readStrokePoints, readStrokePressures, strokePath } from "./freehand";
import { segmentWidths, strokeRuns } from "./pen";

export type NodeRendererProps = {
  node: WhiteboardNode;
  editing: boolean;
  canEdit: boolean;
  onChangeText: (text: string) => void;
};

export type NodeRenderer = (props: NodeRendererProps) => ReactNode;

function TextBody({ node, editing, canEdit, onChangeText }: NodeRendererProps) {
  if (editing) {
    const textProps = stickyTextInputProps(canEdit, onChangeText);
    return (
      <textarea
        className="wb-node-text"
        value={node.content.text ?? ""}
        placeholder={node.nodeType === "text" ? "直接打字…" : "步驟"}
        readOnly={textProps.readOnly}
        onChange={textProps.onChange}
        onPointerDown={(event) => event.stopPropagation()}
        autoFocus={canEdit}
      />
    );
  }
  // 非編輯：靜態層 — 不攔 pointer，整卡可拖（audit：先前只剩 10px 邊框環）
  return <span className="wb-node-static">{node.content.text || (node.nodeType === "text" ? "" : "步驟")}</span>;
}

function ContentBody({ node }: NodeRendererProps) {
  const content = node.content;
  return (
    <>
      {content.thumbnailUrl
        ? <img className="wb-thumb" src={content.thumbnailUrl} alt="" />
        : <span className="wb-thumb-fallback" aria-hidden>{content.mediaKind === "poster" ? "文宣" : content.mediaKind === "video" ? "▶" : content.mediaKind === "plan" ? "☷" : "素材"}</span>}
      <span className="wb-card-copy">
        <strong>{content.title ?? "房間內容"}</strong>
        <small>
          {content.versionLabel ? `${content.versionLabel}` : ""}
          {content.openCommentCount ? ` · ${content.openCommentCount} 則待處理` : ""}
          {content.startTime != null ? ` · ${formatVideoRange(content.startTime, content.endTime)}` : ""}
          {content.subtitle ? ` · ${content.subtitle}` : ""}
        </small>
      </span>
    </>
  );
}

const REGISTRY: Partial<Record<NodeType, NodeRenderer>> = {
  text: TextBody,
  flow: (props) => (props.editing ? <TextBody {...props} /> : <span className="wb-node-static">{props.node.content.text || "步驟"}</span>),
  mindmap: (props) => (props.editing ? <TextBody {...props} /> : <span className="wb-node-static">{props.node.content.text || "主題"}</span>),
  room_content: ContentBody,
  image: ContentBody,
  poll: ({ node }) => (
    <>
      <strong>{node.content.pollQuestion ?? node.content.title ?? "投票"}</strong>
      <small>{node.content.voteCount ?? 0} 人已投</small>
    </>
  ),
  decision: ({ node }) => (
    <>
      <strong>✓ {node.content.text ?? node.content.title ?? "已決定"}</strong>
      {node.content.sourceLabel ? <small>{node.content.sourceLabel}</small> : null}
    </>
  ),
  group: ({ node }) => <span className="wb-node-static">{node.content.title ?? "群組"}</span>,
  link: ({ node }) => <span className="wb-node-static">{node.content.title ?? node.content.text ?? "連結"}</span>,
  ai_result: ({ node }) => (
    <>
      <strong>{node.content.title ?? "AI 建議"}</strong>
      <small>{node.content.sourceLabel ?? "AI 提案"}</small>
    </>
  ),
  calendar_event: ({ node }) => (
    <>
      <strong>{node.content.title ?? node.content.text ?? "時程"}</strong>
      <small>{node.content.subtitle ?? node.content.sourceLabel ?? "日曆事件"}</small>
    </>
  ),
  task: ({ node }) => (
    <>
      <strong>{node.content.title ?? node.content.text ?? "任務"}</strong>
      <small>{node.content.subtitle ?? "任務"}</small>
    </>
  ),
  // freehand（WB03/0026）：content.points 是相對節點左上的筆畫點
  freehand: ({ node }) => {
    const points = readStrokePoints(node.content.points);
    const pressures = readStrokePressures(node.content.pressures, points.length);
    const color = node.content.color || "#e8c27a";
    const base = node.content.strokeWidth || 3;
    return (
      <svg className="wb-freehand" viewBox={`0 0 ${node.width} ${node.height}`} width="100%" height="100%" aria-label="手繪筆畫">
        {pressures.length ? (
          // 有壓感（觸控筆）：逐段線寬。單一 path 畫不出粗細變化，而粗細
          // 正是筆相對於手指的價值所在。
          strokeRuns(points, segmentWidths(pressures, base)).map((run, index) => (
            <polyline
              key={index}
              points={run.points.map(([px, py]) => `${px},${py}`).join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={run.width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))
        ) : (
          <path d={strokePath(points)} fill="none" stroke={color} strokeWidth={base} strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    );
  },
};

/** 未知型別（DB 比 client 新）：誠實 fallback，不假裝看得懂。 */
const FallbackRenderer: NodeRenderer = ({ node }) => (
  <span className="wb-node-static wb-node-unknown">{node.content.title ?? node.content.text ?? `不支援的內容（${node.nodeType}）`}</span>
);

export function rendererFor(nodeType: NodeType): NodeRenderer {
  return REGISTRY[nodeType] ?? FallbackRenderer;
}

/** registry 完整性（測試用）：每個已知 NodeType 都有 renderer。 */
export function registeredNodeTypes(): NodeType[] {
  return Object.keys(REGISTRY) as NodeType[];
}
