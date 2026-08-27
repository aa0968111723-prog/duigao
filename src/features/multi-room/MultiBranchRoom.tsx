import { useEffect, useMemo, useState } from "react";
import type {
  BranchStatus,
  BranchType,
  ContentRelation,
  Guest,
  PlanBlock,
  PlanDocument,
  PollVote,
  Room,
  RoomBranch,
  RoomPoll,
} from "../../lib/types";
import {
  BRANCH_STATUSES,
  BRANCH_TYPES,
  branchOpenCommentCount,
  branchSummary,
  branchStatusLabel,
  branchTypeLabel,
  branchVersions,
  latestBranchVersion,
  normalizeRoomBranches,
  sortBranchesByRecent,
} from "../../lib/roomBranches";
import type { RoomRole } from "../../cloud/roomRepository";
import { VIDEO_ACCEPT } from "../video-review/media";

export type MultiBranchRoomApi = {
  room: Room;
  guest: Guest;
  role: RoomRole | null;
  userId?: string | null;
  canManage: boolean;
  activeBranchId: string | null;
  onOpenBranch: (branchId: string) => void;
  loadingBranchId?: string | null;
  onBackToRoom: () => void;
  onCreateContent: (type: BranchType, name: string, files: FileList | null) => void;
  onAddFiles: (branchId: string, files: FileList | null) => void;
  onUpdateBranch: (branchId: string, patch: Partial<Pick<RoomBranch, "name" | "sortOrder" | "status">>) => void;
  onSavePlan: (plan: PlanDocument) => void;
  onCreateRelation: (relation: ContentRelation) => void;
  onDeleteRelation: (relationId: string) => void;
  onCreatePoll: (poll: RoomPoll) => void;
  onVotePoll: (vote: PollVote) => void;
  chatInput: string;
  setChatInput: (value: string) => void;
  sendChat: () => void;
  onShare: () => void;
  onOpenAi: (assetId?: string) => void;
  onGoHome: () => void;
};

type RoomTab = "overview" | "poster" | "video" | "plan";

const TABS: { id: RoomTab; label: string; type?: BranchType }[] = [
  { id: "overview", label: "總覽" },
  { id: "poster", label: "文宣", type: "poster" },
  { id: "video", label: "影片", type: "video" },
  { id: "plan", label: "企劃", type: "plan" },
];

function emptyPlan(branch: RoomBranch): PlanDocument {
  return { branchId: branch.id, title: branch.name, description: "", blocks: [], updatedAt: Date.now() };
}

function branchHasType(branch: RoomBranch, type: BranchType): boolean {
  return branch.branchType === type || (type === "plan" && branch.branchType === "copy");
}

function relativeTime(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function countVotes(room: Room, pollId: string): number {
  return (room.pollVotes ?? []).filter((vote) => vote.pollId === pollId).length;
}

function selectedVote(room: Room, pollId: string, userId: string): string | undefined {
  return (room.pollVotes ?? []).find((vote) => vote.pollId === pollId && vote.userId === userId)?.option;
}

function BranchCard({
  room,
  branch,
  onOpen,
  draggable,
  onDrop,
}: {
  room: Room;
  branch: RoomBranch;
  onOpen: () => void;
  draggable?: boolean;
  onDrop?: () => void;
}) {
  const version = latestBranchVersion(room, branch.id);
  const loadedVersions = branchVersions(room, branch.id);
  const summary = branchSummary(room, branch.id);
  const versionCount = loadedVersions.length ? loadedVersions.filter((item) => !item.archivedAt).length : summary.versionCount;
  const openComments = loadedVersions.length ? branchOpenCommentCount(room, branch.id) : summary.openCommentCount;
  const relatedCount = (room.relations ?? []).filter(
    (relation) => relation.fromBranchId === branch.id || relation.toBranchId === branch.id,
  ).length;
  const plan = room.plans?.find((item) => item.branchId === branch.id);
  return (
    <button
      type="button"
      className="project-branch-card"
      data-testid={`branch-card-${branch.id}`}
      draggable={draggable}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onClick={onOpen}
    >
      <span className={`project-branch-icon project-branch-${branch.branchType}`} aria-hidden>
        {branch.branchType === "poster" ? "▧" : branch.branchType === "video" ? "▶" : "☷"}
      </span>
      <span className="project-branch-copy">
        <span className="project-branch-title">{branch.name}</span>
        <span className="project-branch-meta">
          {branch.branchType === "plan" || branch.branchType === "copy"
            ? plan?.title || "尚未開始編輯"
            : version
              ? `${version.label}${versionCount > 1 ? ` · ${versionCount} 版` : ""}`
              : summary.latestLabel
                ? `${summary.latestLabel}${versionCount > 1 ? ` · ${versionCount} 版` : ""}`
              : "尚未加入內容"}
          {openComments > 0 && ` · ${openComments} 則待處理`}
          {relatedCount > 0 && ` · ${relatedCount} 項相關`}
        </span>
      </span>
      <span className={`project-status project-status-${branch.status}`}>{branchStatusLabel(branch.status)}</span>
      <span className="project-branch-chevron" aria-hidden>›</span>
    </button>
  );
}

function EmptyType({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <div className="project-empty-type">
      <p>這裡還沒有{label}</p>
      <button type="button" className="project-text-button" onClick={onAdd}>＋ 加入第一份{label}</button>
    </div>
  );
}

function PollCard({ poll, room, userId, onVote }: { poll: RoomPoll; room: Room; userId: string; onVote: (poll: RoomPoll, option: string) => void }) {
  // Cloud poll votes are keyed by auth.uid(), while a local-only room uses the
  // device guest id. Keep the visual selection in step with the exact key sent
  // by votePoll so a mobile voter sees their choice immediately after a reload.
  const chosen = selectedVote(room, poll.id, userId);
  return (
    <article className="project-poll-card" data-testid={`poll-${poll.id}`}>
      <div className="project-poll-head">
        <strong>{poll.question}</strong>
        <span>{countVotes(room, poll.id)} 人已投</span>
      </div>
      <div className="project-poll-options">
        {poll.options.map((option) => (
          <button
            type="button"
            key={option}
            className={`project-poll-option ${chosen === option ? "is-chosen" : ""}`}
            onClick={() => onVote(poll, option)}
          >
            {option}
            {chosen === option && <span aria-hidden>✓</span>}
          </button>
        ))}
      </div>
    </article>
  );
}

function PlanEditor({
  room,
  branch,
  canManage,
  onSave,
  onCreateRelation,
  onDeleteRelation,
}: {
  room: Room;
  branch: RoomBranch;
  canManage: boolean;
  onSave: (plan: PlanDocument) => void;
  onCreateRelation: (relation: ContentRelation) => void;
  onDeleteRelation: (relationId: string) => void;
}) {
  const saved = useMemo(
    () => room.plans?.find((item) => item.branchId === branch.id) ?? emptyPlan(branch),
    [branch.id, branch.name, room.plans],
  );
  const [draft, setDraft] = useState<PlanDocument>(saved);
  const [relationTarget, setRelationTarget] = useState("");

  useEffect(() => setDraft(saved), [saved]);

  const relations = (room.relations ?? []).filter(
    (relation) => relation.fromBranchId === branch.id || relation.toBranchId === branch.id,
  );
  const relatedIds = new Set(
    relations.map((relation) => (relation.fromBranchId === branch.id ? relation.toBranchId : relation.fromBranchId)),
  );
  const relatedBranches = (room.branches ?? []).filter((item) => relatedIds.has(item.id));

  const updateBlock = (id: string, patch: Partial<PlanBlock>) => {
    setDraft((current) => ({
      ...current,
      blocks: current.blocks.map((block) => (block.id === id ? ({ ...block, ...patch } as PlanBlock) : block)),
    }));
  };

  const addBlock = (kind: PlanBlock["kind"]) => {
    const id = crypto.randomUUID();
    const next: PlanBlock = kind === "checklist"
      ? { id, kind, text: "待辦事項", checked: false }
      : kind === "link"
        ? { id, kind, text: "相關連結", url: "https://" }
        : { id, kind, text: kind === "list" ? "條列內容" : "新增段落" };
    setDraft((current) => ({ ...current, blocks: [...current.blocks, next] }));
  };

  return (
    <div className="project-plan-editor" data-testid="plan-editor">
      <label className="project-field">
        <span>標題</span>
        <input value={draft.title} disabled={!canManage} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
      </label>
      <label className="project-field">
        <span>說明</span>
        <textarea
          value={draft.description}
          disabled={!canManage}
          placeholder="這份企劃想完成什麼？"
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      <div className="project-blocks">
        {draft.blocks.length === 0 && <p className="project-muted">從底下新增一段內容，手機上保持簡單好改。</p>}
        {draft.blocks.map((block) => (
          <div className={`project-block project-block-${block.kind}`} key={block.id}>
            {block.kind === "checklist" && (
              <input
                type="checkbox"
                checked={block.checked}
                disabled={!canManage}
                onChange={(event) => updateBlock(block.id, { checked: event.target.checked })}
                aria-label="完成項目"
              />
            )}
            <input
              value={block.text}
              disabled={!canManage}
              onChange={(event) => updateBlock(block.id, { text: event.target.value })}
              aria-label={block.kind === "list" ? "條列內容" : block.kind === "link" ? "連結文字" : "段落內容"}
            />
            {block.kind === "link" && (
              <input
                className="project-link-url"
                value={block.url}
                disabled={!canManage}
                onChange={(event) => updateBlock(block.id, { url: event.target.value })}
                aria-label="連結網址"
              />
            )}
            {canManage && (
              <button
                type="button"
                className="project-block-remove"
                aria-label="刪除段落"
                onClick={() => setDraft({ ...draft, blocks: draft.blocks.filter((item) => item.id !== block.id) })}
              >×</button>
            )}
          </div>
        ))}
      </div>
      {canManage && (
        <div className="project-plan-actions">
          <button type="button" onClick={() => addBlock("paragraph")}>＋段落</button>
          <button type="button" onClick={() => addBlock("list")}>＋清單</button>
          <button type="button" onClick={() => addBlock("checklist")}>＋待辦</button>
          <button type="button" onClick={() => addBlock("link")}>＋連結</button>
          <button type="button" className="project-save-button" onClick={() => onSave({ ...draft, updatedAt: Date.now() })}>完成</button>
        </div>
      )}
      <section className="project-related">
        <div className="project-section-title-row"><h3>相關內容</h3><span>{relatedBranches.length} 項</span></div>
        <div className="project-related-list">
          {relatedBranches.map((related) => {
            const relation = relations.find((item) => item.fromBranchId === related.id || item.toBranchId === related.id);
            return (
              <span className="project-related-chip" key={related.id}>
                {branchTypeLabel(related.branchType)} · {related.name}
                {canManage && relation && <button type="button" onClick={() => onDeleteRelation(relation.id)} aria-label={`移除${related.name}`}>×</button>}
              </span>
            );
          })}
        </div>
        {canManage && (room.branches ?? []).some((item) => item.id !== branch.id && !relatedIds.has(item.id)) && (
          <div className="project-related-add">
            <select value={relationTarget} onChange={(event) => setRelationTarget(event.target.value)} aria-label="選擇相關內容">
              <option value="">加入相關內容</option>
              {(room.branches ?? []).filter((item) => item.id !== branch.id && !relatedIds.has(item.id)).map((item) => (
                <option value={item.id} key={item.id}>{item.name}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!relationTarget}
              onClick={() => {
                if (!relationTarget) return;
                onCreateRelation({
                  id: crypto.randomUUID(),
                  roomId: room.id,
                  fromBranchId: branch.id,
                  toBranchId: relationTarget,
                  relationType: "related",
                  createdBy: "local",
                  createdAt: Date.now(),
                });
                setRelationTarget("");
              }}
            >加入</button>
          </div>
        )}
      </section>
    </div>
  );
}

function CreateSheet({ onClose, onCreate, initialType }: { onClose: () => void; onCreate: MultiBranchRoomApi["onCreateContent"]; initialType?: BranchType }) {
  const [type, setType] = useState<BranchType | null>(initialType ?? null);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const needsFile = type === "poster" || type === "video";
  return (
    <div className="project-scrim" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="project-sheet" role="dialog" aria-modal="true" aria-label="新增內容" data-testid="create-content-sheet">
        <div className="project-sheet-grip" aria-hidden />
        {!type ? (
          <>
            <h2>你要新增什麼？</h2>
            <div className="project-create-options">
              {(["poster", "video", "plan", "copy"] as BranchType[]).map((item) => (
                <button type="button" key={item} onClick={() => setType(item)}>
                  <span aria-hidden>{item === "poster" ? "▧" : item === "video" ? "▶" : "☷"}</span>
                  {item === "copy" ? "企劃 / 文案" : branchTypeLabel(item)}
                </button>
              ))}
            </div>
          </>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); if (name.trim() && (!needsFile || files?.length)) { onCreate(type, name.trim(), files); onClose(); } }}>
            <button type="button" className="project-sheet-back" onClick={() => setType(null)}>‹ 返回</button>
            <h2>新增{type === "copy" ? "文案" : branchTypeLabel(type)}</h2>
            <label className="project-field"><span>名稱</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={type === "poster" ? "例如：擺攤文宣" : type === "video" ? "例如：招生影片" : "例如：擺攤計畫"} /></label>
            {needsFile && (
              <label className="project-file-picker">
                <span>{files?.[0]?.name ?? (type === "poster" ? "選一張圖片" : "選一支影片")}</span>
                <input type="file" accept={type === "poster" ? "image/*" : VIDEO_ACCEPT} onChange={(event) => setFiles(event.target.files)} />
              </label>
            )}
            <button type="submit" className="project-save-button project-submit" disabled={!name.trim() || (needsFile && !files?.length)}>建立</button>
          </form>
        )}
        <button type="button" className="project-sheet-close" onClick={onClose}>取消</button>
      </section>
    </div>
  );
}

function PollSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (question: string, options: string[]) => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["選項 A", "選項 B"]);
  return (
    <div className="project-scrim" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <form className="project-sheet" role="dialog" aria-modal="true" aria-label="新增待決策" onSubmit={(event) => { event.preventDefault(); const clean = options.map((item) => item.trim()).filter(Boolean); if (question.trim() && clean.length >= 2) { onCreate(question.trim(), clean); onClose(); } }}>
        <div className="project-sheet-grip" aria-hidden />
        <h2>新增待決策</h2>
        <label className="project-field"><span>問題</span><input autoFocus value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：這週先主推茶會還是演講？" /></label>
        {options.map((option, index) => <label className="project-field" key={index}><span>選項 {String.fromCharCode(65 + index)}</span><input value={option} onChange={(event) => setOptions(options.map((item, i) => i === index ? event.target.value : item))} /></label>)}
        {options.length < 4 && <button type="button" className="project-text-button" onClick={() => setOptions([...options, "新選項"])}>＋增加選項</button>}
        <button type="submit" className="project-save-button project-submit" disabled={!question.trim() || options.filter((item) => item.trim()).length < 2}>建立</button>
        <button type="button" className="project-sheet-close" onClick={onClose}>取消</button>
      </form>
    </div>
  );
}

export function MultiBranchRoom({ api }: { api: MultiBranchRoomApi }) {
  const normalized = normalizeRoomBranches(api.room);
  const [tab, setTab] = useState<RoomTab>(api.activeBranchId ? "plan" : "overview");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [sortRecent, setSortRecent] = useState(true);

  const activeBranch = normalized.branches?.find((branch) => branch.id === api.activeBranchId) ?? null;
  const branches = useMemo(() => {
    const base = normalized.branches ?? [];
    const searched = search.trim().toLowerCase()
      ? base.filter((branch) => branch.name.toLowerCase().includes(search.trim().toLowerCase()))
      : base;
    return sortRecent ? sortBranchesByRecent(searched) : [...searched].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [normalized.branches, search, sortRecent]);

  useEffect(() => {
    if (activeBranch) setTab(activeBranch.branchType === "video" ? "video" : activeBranch.branchType === "poster" ? "poster" : "plan");
  }, [activeBranch?.id, activeBranch?.branchType]);

  const tabBranches = (type: BranchType) => branches.filter((branch) => branchHasType(branch, type) && branch.status !== "archived");
  const [createType, setCreateType] = useState<BranchType | undefined>();
  const openCreate = (type?: BranchType) => {
    setCreateType(type);
    setCreateOpen(true);
  };

  const createContent = (type: BranchType, name: string, files: FileList | null) => api.onCreateContent(type, name, files);

  const createPoll = (question: string, options: string[]) => api.onCreatePoll({
    id: crypto.randomUUID(), roomId: api.room.id, question, options, createdBy: api.guest.id, createdAt: Date.now(), updatedAt: Date.now(),
  });

  const votePoll = (poll: RoomPoll, option: string) => api.onVotePoll({
    pollId: poll.id, roomId: api.room.id, userId: api.userId ?? api.guest.id, option, createdAt: Date.now(),
  });

  const recentComments = [...api.room.comments].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  const branchNameForVersion = (versionId: string) => {
    const comment = recentComments.find((item) => item.versionId === versionId);
    const version = api.room.versions.find((item) => item.id === versionId);
    const branch = normalized.branches?.find((item) => item.id === comment?.branchId || item.id === version?.branchId);
    return branch?.name ?? "內容";
  };

  return (
    <div className="project-room" data-testid="multi-branch-room">
      <header className="project-room-header">
        <button type="button" className="project-home-button" onClick={api.onGoHome} aria-label="回到房間列表">●</button>
        {api.activeBranchId ? <button type="button" className="project-back-button" onClick={api.onBackToRoom}>‹</button> : null}
        <div className="project-room-heading"><span className="project-kicker">活動房</span><h1>{api.room.title}</h1></div>
        <div className="project-head-actions">
          <button type="button" className="project-ai-button" onClick={() => api.onOpenAi()}>✦ AI</button>
          <button type="button" className="project-share-button" onClick={api.onShare}>分享</button>
        </div>
      </header>

      {!api.activeBranchId && (
        <div className="project-search-wrap">
          <span aria-hidden>⌕</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋茶會、擺攤、招生…" aria-label="搜尋房間內容" />
          {search && <button type="button" onClick={() => setSearch("")} aria-label="清除搜尋">×</button>}
        </div>
      )}

      {api.activeBranchId && activeBranch ? (
          <main className="project-branch-detail">
            <div className="project-detail-head">
            <div><span className="project-kicker">{branchTypeLabel(activeBranch.branchType)}</span><h2>{activeBranch.name}</h2></div>
            {api.canManage ? (
              <select value={activeBranch.status} onChange={(event) => api.onUpdateBranch(activeBranch.id, { status: event.target.value as BranchStatus })} aria-label="分支狀態">
                {BRANCH_STATUSES.map((status) => <option value={status} key={status}>{branchStatusLabel(status)}</option>)}
              </select>
            ) : <span className={`project-status project-status-${activeBranch.status}`}>{branchStatusLabel(activeBranch.status)}</span>}
          </div>
          {api.loadingBranchId === activeBranch.id ? (
            <div className="project-branch-empty-detail project-loading-detail"><span className="project-spinner" aria-hidden />正在載入這份內容…</div>
          ) : (activeBranch.branchType === "plan" || activeBranch.branchType === "copy") ? (
            <PlanEditor room={normalized} branch={activeBranch} canManage={api.canManage} onSave={api.onSavePlan} onCreateRelation={api.onCreateRelation} onDeleteRelation={api.onDeleteRelation} />
          ) : (
            <div className="project-branch-empty-detail">
              <p>{branchVersions(normalized, activeBranch.id).length ? "準備好進入檢視器。" : `這份${branchTypeLabel(activeBranch.branchType)}還沒有版本。`}</p>
              {api.canManage && (
                <label className="project-upload-button">
                  <span>＋ {branchVersions(normalized, activeBranch.id).length ? "新增版本" : `加入${branchTypeLabel(activeBranch.branchType)}`}</span>
                  <input type="file" accept={activeBranch.branchType === "poster" ? "image/*" : VIDEO_ACCEPT} onChange={(event) => api.onAddFiles(activeBranch.id, event.target.files)} />
                </label>
              )}
            </div>
          )}
        </main>
      ) : (
        <>
          <nav className="project-tabs" aria-label="房間內容">
            {TABS.map((item) => <button type="button" key={item.id} className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>{item.label}{item.type && tabBranches(item.type).length > 0 ? <small>{tabBranches(item.type).length}</small> : null}</button>)}
          </nav>
          <main className="project-room-main">
            {search.trim() ? (
              <section className="project-section" data-testid="search-results">
                <div className="project-section-title-row"><h2>搜尋結果</h2><span>{branches.length} 項</span></div>
                {branches.length ? branches.map((branch) => <BranchCard key={branch.id} room={normalized} branch={branch} onOpen={() => api.onOpenBranch(branch.id)} />) : <p className="project-muted">找不到相關內容</p>}
              </section>
            ) : tab === "overview" ? (
              <>
                <section className="project-section project-welcome">
                  <p className="project-section-eyebrow">{normalized.branches?.length ? "這個活動房正在進行" : "從一份內容開始"}</p>
                  <h2>{normalized.branches?.length ? "最近發生了什麼" : "這間房還沒有內容"}</h2>
                  {!normalized.branches?.length && <p className="project-muted">把文宣、影片和企劃放在一起，之後再慢慢補齊。</p>}
                </section>
                <section className="project-section" data-testid="recent-updates"><div className="project-section-title-row"><h2>最近更新</h2><span>查看全部內容</span></div>
                  {branches.slice(0, 4).map((branch) => <div className="project-update-row" key={branch.id} onClick={() => api.onOpenBranch(branch.id)}><span>{branchTypeLabel(branch.branchType)}</span><strong>{branch.name}</strong><small>{relativeTime(branch.updatedAt)}</small></div>)}
                  {!branches.length && <p className="project-muted">還沒有最近更新</p>}
                </section>
                <section className="project-section" data-testid="decisions"><div className="project-section-title-row"><h2>待決策</h2>{api.canManage && <button type="button" className="project-text-button" onClick={() => setPollOpen(true)}>＋ 新增</button>}</div>
                  {(api.room.polls ?? []).filter((poll) => !poll.closedAt).slice(0, 3).map((poll) => <PollCard key={poll.id} poll={poll} room={api.room} userId={api.userId ?? api.guest.id} onVote={votePoll} />)}
                  {!(api.room.polls ?? []).some((poll) => !poll.closedAt) && <p className="project-muted">目前沒有待決策</p>}
                </section>
                <section className="project-section"><div className="project-section-title-row"><h2>進行中的分支</h2><button type="button" className="project-sort-button" onClick={() => setSortRecent((value) => !value)}>{sortRecent ? "依最近更新" : "依順序"}</button></div>
                  {branches.filter((branch) => branch.status === "in_progress" || branch.status === "pending").slice(0, 5).map((branch) => <BranchCard key={branch.id} room={normalized} branch={branch} onOpen={() => api.onOpenBranch(branch.id)} />)}
                </section>
                <section className="project-section" data-testid="recent-feedback"><div className="project-section-title-row"><h2>最近回饋</h2><span>{api.room.comments.length} 則</span></div>
                  {recentComments.map((comment) => <button type="button" className="project-feedback-row" key={comment.id} onClick={() => { const branch = normalized.branches?.find((item) => item.id === comment.branchId || branchVersions(normalized, item.id).some((version) => version.id === comment.versionId)); if (branch) api.onOpenBranch(branch.id); }}><span className="project-feedback-dot" style={{ background: comment.authorColor }} /> <span><strong>{branchNameForVersion(comment.versionId)}</strong><small>{comment.body}</small></span></button>)}
                  {!recentComments.length && <p className="project-muted">還沒有回饋</p>}
                </section>
                <section className="project-section project-room-chat"><div className="project-section-title-row"><h2>房間討論</h2><span>跨內容</span></div><div className="project-chat-list">{api.room.messages.slice(-3).map((message) => <p key={message.id}><b>{message.authorName}</b>{message.body}</p>)}{!api.room.messages.length && <p className="project-muted">先留一句房間層級的討論吧</p>}</div><div className="project-chat-input"><input value={api.chatInput} onChange={(event) => api.setChatInput(event.target.value)} placeholder="這週先主推哪一份？" onKeyDown={(event) => event.key === "Enter" && api.sendChat()} /><button type="button" onClick={api.sendChat} disabled={!api.chatInput.trim()}>送出</button></div></section>
              </>
            ) : (
              <section className="project-section project-list-section" data-testid={`${tab}-branches`}>
                <div className="project-section-title-row"><div><span className="project-section-eyebrow">{tab === "poster" ? "圖片與海報" : tab === "video" ? "影片與 Reel" : "企劃、文案與清單"}</span><h2>{TABS.find((item) => item.id === tab)?.label}</h2></div>{api.canManage && <button type="button" className="project-text-button" onClick={() => openCreate(tab === "plan" ? "plan" : tab)}>＋ 新增{tab === "poster" ? "文宣" : tab === "video" ? "影片" : "企劃"}</button>}</div>
                <div className="project-branch-list">{tabBranches(tab === "poster" ? "poster" : tab === "video" ? "video" : "plan").map((branch) => <BranchCard key={branch.id} room={normalized} branch={branch} onOpen={() => api.onOpenBranch(branch.id)} draggable onDrop={() => undefined} />)}</div>
                {!tabBranches(tab === "poster" ? "poster" : tab === "video" ? "video" : "plan").length && api.canManage && <EmptyType label={tab === "poster" ? "文宣" : tab === "video" ? "影片" : "企劃"} onAdd={() => openCreate(tab === "plan" ? "plan" : tab)} />}
              </section>
            )}
          </main>
          {api.canManage && <button type="button" className="project-fab" onClick={() => setCreateOpen(true)} aria-label="新增內容">＋</button>}
          <nav className="project-bottom-nav" aria-label="主要導覽">{TABS.map((item) => <button type="button" key={item.id} className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}><span>{item.id === "overview" ? "⌂" : item.id === "poster" ? "▧" : item.id === "video" ? "▶" : "☷"}</span>{item.label}</button>)}</nav>
        </>
      )}
      {createOpen && <CreateSheet initialType={createType} onClose={() => { setCreateOpen(false); setCreateType(undefined); }} onCreate={createContent} />}
      {pollOpen && <PollSheet onClose={() => setPollOpen(false)} onCreate={createPoll} />}
    </div>
  );
}
