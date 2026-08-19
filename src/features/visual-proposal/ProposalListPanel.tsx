import { useState } from "react";
import { useProposalStore, type ProposalAuthor, type ProposalType } from "./store";
import { PROPOSAL_TYPES } from "./helpers";
import { ProposalCard, type ProposalPinBinding } from "./ProposalCard";
import { ProposalBackgroundControls } from "./ProposalBackgroundControls";
import { ProposalSummary } from "./ProposalSummary";
import type { ShowToast } from "../../toast";

type Props = {
  roomId: string;
  versionId: string;
  author: ProposalAuthor;
  showToast: ShowToast;
  pin?: ProposalPinBinding;
};

/**
 * 提案列表: every proposal on this poster version as a card, plus the settings
 * for whichever one is open. It is a discussion list first and a settings pane
 * second — the artwork is edited on the poster, never in here.
 */
export function ProposalListPanel({ roomId, versionId, author, showToast, pin }: Props) {
  const proposal = useProposalStore(roomId, versionId, author);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const active = proposal.active;

  const create = (type: ProposalType) => {
    proposal.create({ type });
    setCreating(false);
    setSettings(false);
  };

  return (
    <div className="plist">
      <div className="plist-cards">
        {proposal.docs.length === 0 && <p className="proposal-muted">這一版還沒有視覺提案。挑一個類型就能開始。</p>}
        {proposal.docs.map((doc) => (
          <ProposalCard
            key={doc.id}
            doc={doc}
            active={doc.id === active?.id}
            userId={proposal.userId}
            pin={pin}
            onSelect={() => proposal.selectProposal(doc.id)}
            onToggleSupport={() => proposal.toggleSupport(doc.id)}
            onComment={(body) => proposal.addComment(doc.id, body)}
            onStatus={(status) => {
              proposal.setStatus(doc.id, status);
              if (status === "accepted") showToast("已標記為採用的提案", { tone: "success" });
            }}
          />
        ))}
      </div>

      {creating ? (
        <div className="plist-typepick" role="group" aria-label="選擇提案類型">
          {PROPOSAL_TYPES.map((t) => (
            <button key={t.key} type="button" className="proposal-chip" onClick={() => create(t.key)}>
              {t.label}
            </button>
          ))}
          <button type="button" className="proposal-quiet" onClick={() => setCreating(false)}>
            取消
          </button>
        </div>
      ) : (
        <button type="button" className="proposal-primary plist-new" onClick={() => setCreating(true)}>
          ＋ 新增提案
        </button>
      )}

      {active && (
        <>
          <button
            type="button"
            className={`proposal-quiet plist-settings-toggle ${settings ? "is-on" : ""}`}
            onClick={() => setSettings((v) => !v)}
            aria-expanded={settings}
          >
            {settings ? "收起提案設定" : `提案設定 · ${active.title}`}
          </button>

          {settings && (
            <div className="plist-settings">
              <ProposalMetaFields
                key={active.id}
                title={active.title}
                description={active.description}
                onTitle={(value) => proposal.renameProposal(active.id, value)}
                onDescription={(value) => proposal.setDescription(active.id, value)}
              />
              <div className="proposal-field">
                <span>類型</span>
                <div className="proposal-chiprow" role="group" aria-label="提案類型">
                  {PROPOSAL_TYPES.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      className={`proposal-chip ${active.type === t.key ? "is-on" : ""}`}
                      aria-pressed={active.type === t.key}
                      onClick={() => proposal.setType(active.id, t.key)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <details className="proposal-section">
                <summary>背景</summary>
                <div className="proposal-section-body">
                  <ProposalBackgroundControls roomId={roomId} versionId={versionId} author={author} showToast={showToast} />
                </div>
              </details>

              <details className="proposal-section">
                <summary>轉成修改建議</summary>
                <div className="proposal-section-body">
                  <ProposalSummary roomId={roomId} versionId={versionId} author={author} showToast={showToast} />
                </div>
              </details>

              <div className="proposal-manage">
                <button type="button" className="proposal-quiet" onClick={proposal.undo} disabled={!proposal.canUndo}>
                  復原
                </button>
                <button type="button" className="proposal-quiet" onClick={proposal.redo} disabled={!proposal.canRedo}>
                  重做
                </button>
                <button type="button" className="proposal-quiet" onClick={() => proposal.duplicateProposal(active.id)}>
                  複製提案
                </button>
                {confirmDelete ? (
                  <span className="pdock-confirm">
                    刪除「{active.title}」？
                    <button
                      type="button"
                      className="proposal-danger"
                      onClick={() => {
                        proposal.deleteProposal(active.id);
                        setConfirmDelete(false);
                        showToast("已刪除提案，原稿不受影響", { action: { label: "復原", onClick: () => proposal.undo() } });
                      }}
                    >
                      刪除
                    </button>
                    <button type="button" className="proposal-quiet" onClick={() => setConfirmDelete(false)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button type="button" className="proposal-quiet" onClick={() => setConfirmDelete(true)}>
                    刪除提案
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type MetaFieldsProps = {
  title: string;
  description: string;
  onTitle: (value: string) => void;
  onDescription: (value: string) => void;
};

/**
 * Title / description keep a local draft and only commit on blur or Enter.
 * Committing per keystroke would write IndexedDB and push a cloud revision for
 * every letter, which is how you collect revision conflicts for nothing.
 * Remounted per proposal via `key`, so the draft never leaks between cards.
 */
function ProposalMetaFields({ title, description, onTitle, onDescription }: MetaFieldsProps) {
  const [titleDraft, setTitleDraft] = useState(title);
  const [descDraft, setDescDraft] = useState(description);

  return (
    <>
      <label className="proposal-field">
        <span>標題</span>
        <input
          className="proposal-rename-input"
          value={titleDraft}
          aria-label="提案標題"
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => onTitle(titleDraft)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
          }}
        />
      </label>
      <label className="proposal-field">
        <span>說明（想解決什麼？）</span>
        <textarea
          rows={2}
          value={descDraft}
          aria-label="提案說明"
          onChange={(e) => setDescDraft(e.target.value)}
          onBlur={() => onDescription(descDraft)}
        />
      </label>
    </>
  );
}
