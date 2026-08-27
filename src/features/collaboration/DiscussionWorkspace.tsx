import { useMemo, useState } from "react";
import { isFeatureEnabled } from "../../ai/featureFlags";
import { answerFromContext, applyBackToWhiteboard, retrieveRoomContext } from "../../ai/roomContext";
import { discussionTabs, plusMenuItems, voiceIsWorkingRoom } from "../../collaboration/discussionShell";
import {
  addRoomContentReference,
  addSticky,
  createFlow,
  createMindmap,
  emptyGraph,
  type WhiteboardGraph,
} from "../../collaboration/whiteboard";
import { searchLibrary, type LibraryAsset } from "../../collaboration/library";
import type { Room } from "../../lib/types";
import "./discussion.css";

export type DiscussionWorkspaceProps = {
  room: Room;
  graph?: WhiteboardGraph;
  library?: LibraryAsset[];
  onGraphChange?: (graph: WhiteboardGraph) => void;
};

export function DiscussionWorkspace({ room, graph: incoming, library = [], onGraphChange }: DiscussionWorkspaceProps) {
  const tabs = discussionTabs();
  const [tab, setTab] = useState<"chat" | "board" | "voice">("chat");
  const [plusOpen, setPlusOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [query, setQuery] = useState("幫我整理目前方向。");
  const [answer, setAnswer] = useState("");
  const [graph, setGraph] = useState<WhiteboardGraph>(incoming ?? emptyGraph(room.id));
  const [selected, setSelected] = useState<string[]>([]);

  const setNext = (next: WhiteboardGraph) => {
    setGraph(next);
    onGraphChange?.(next);
  };

  const chat = room.messages;
  const rankedLibrary = useMemo(() => searchLibrary(library, "茶會宣傳"), [library]);

  const ask = () => {
    const context = retrieveRoomContext({
      room,
      query,
      whiteboard: graph,
      selectedNodeIds: selected,
    });
    setAnswer(answerFromContext(query, context, room));
  };

  const applyBoard = () => setNext(applyBackToWhiteboard(graph, query || "加入白板"));

  return (
    <div className="discussion-shell" data-testid="discussion-shell" data-first-screen="對話,白板,語音">
      <nav className="discussion-tabs" aria-label="討論">
        {tabs.map((item) => (
          <button
            type="button"
            key={item.id}
            data-testid={`discussion-tab-${item.id}`}
            className={tab === item.id ? "is-active" : ""}
            disabled={item.id === "voice" && !item.enabled}
            onClick={() => {
              if (item.id === "voice" && !item.enabled) return;
              setTab(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === "chat" && (
        <section className="discussion-chat" data-testid="discussion-chat">
          {chat.length ? chat.slice(-20).map((message) => (
            <p key={message.id}><b>{message.authorName}</b> {message.body}</p>
          )) : <p className="discussion-muted">先留一句房間討論。</p>}
        </section>
      )}

      {tab === "board" && isFeatureEnabled("collaboration.whiteboard") && (
        <section className="discussion-board" data-testid="discussion-board">
          {graph.nodes.map((node) => (
            <button
              type="button"
              key={node.id}
              className={`board-node board-node-${node.type}${selected.includes(node.id) ? " is-selected" : ""}`}
              data-testid={`board-node-${node.id}`}
              style={{ left: node.x, top: node.y }}
              onClick={() => setSelected((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id])}
            >
              {node.text}
            </button>
          ))}
          {!graph.nodes.length && <p className="discussion-muted">點 ＋ 放便利貼，或把房間內容拉進來。</p>}
        </section>
      )}

      {tab === "voice" && (
        <section className="discussion-voice" data-testid="discussion-voice">
          {voiceIsWorkingRoom()
            ? <p>語音房間</p>
            : <p data-testid="voice-disabled">語音尚未開放</p>}
        </section>
      )}

      {tab === "board" && (
        <div className="discussion-dock">
          <button type="button" data-testid="board-plus" onClick={() => setPlusOpen((value) => !value)}>＋</button>
          <button type="button">搜尋</button>
          <button type="button">整理</button>
          <button type="button">更多</button>
        </div>
      )}

      {plusOpen && (
        <div className="discussion-plus" data-testid="board-plus-menu">
          {plusMenuItems().map((item) => (
            <button
              type="button"
              key={item}
              onClick={() => {
                if (item === "便利貼") setNext(addSticky(graph, "便利貼").graph);
                if (item === "流程") setNext(createFlow(graph, ["招生", "擺攤", "互動", "QR", "茶會"]));
                if (item === "心智圖") setNext(createMindmap(graph, "招生", ["擺攤", "茶會"]));
                if (item === "房間內容") {
                  const poster = room.branches?.find((branch) => branch.branchType === "poster");
                  if (poster) {
                    setNext(addRoomContentReference(graph, {
                      type: "poster",
                      title: poster.name,
                      branchId: poster.id,
                      versionId: room.versions.find((version) => version.branchId === poster.id)?.id,
                    }).graph);
                  }
                }
                if (item === "素材") {
                  const top = rankedLibrary[0];
                  if (top) setNext(addRoomContentReference(graph, { type: "asset", title: top.title, assetId: top.id }).graph);
                }
                setPlusOpen(false);
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}

      <button type="button" className="discussion-ai" data-testid="discussion-ai" aria-label="AI" onClick={() => setAiOpen(true)}>✦</button>

      {aiOpen && (
        <div className="discussion-ai-sheet" data-testid="discussion-ai-sheet">
          <textarea value={query} onChange={(event) => setQuery(event.target.value)} />
          <button type="button" onClick={ask}>問 AI</button>
          {answer && <p data-testid="discussion-ai-answer">{answer}</p>}
          {answer && <button type="button" data-testid="apply-whiteboard" onClick={applyBoard}>加入白板</button>}
          <button type="button" onClick={() => setAiOpen(false)}>關閉</button>
        </div>
      )}
    </div>
  );
}
