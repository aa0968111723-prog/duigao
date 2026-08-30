import { useEffect, useMemo, useState } from "react";
import type {
  AssetAnalysisJob,
  ContextCitation,
  IntelligentAsset,
  RoomContextRequest,
  RoomContextResponse,
} from "../../lib/assetIntelligence";
import { ANALYSIS_STATUS_LABEL, ASSET_TYPE_LABEL, formatSeconds } from "../../lib/assetIntelligence";
import {
  proposalsFromResponse,
  type AiProposal,
  type ApplyProposalResult,
} from "../../ai/proposals";
import { AGENT_UNCONFIGURED_COPY, IMAGINE_NOT_VERSION_COPY, estimateImagineVideoUsd } from "../../ai/roomAgentContract";
import { proposalShowsSources } from "../schedule/proposals";
import "./asset-ai.css";

type Props = {
  roomTitle: string;
  assets: IntelligentAsset[];
  jobs?: AssetAnalysisJob[];
  selectedAssetIds?: string[];
  response: RoomContextResponse | null;
  loading?: boolean;
  error?: string | null;
  onAsk: (request: RoomContextRequest) => Promise<RoomContextResponse>;
  onClose: () => void;
  onFocus: (citation: ContextCitation) => void;
  onRetryAnalysis?: (assetId: string) => void;
  onUpdatePolicy?: (assetId: string, patch: { aiReadable: boolean; externalAiAllowed: boolean }) => Promise<void>;
  onUpdateHumanMetadata?: (assetId: string, input: { title?: string; summary?: string; tags?: string[] }) => Promise<void>;
  onApplyProposal?: (proposal: AiProposal, extraConfirmed?: boolean) => Promise<ApplyProposalResult> | ApplyProposalResult;
  onRejectProposal?: (proposal: AiProposal) => void;
  onCancel?: () => void;
  canManage?: boolean;
};

const PRESETS = [
  "這次企劃還缺什麼？",
  "哪些素材最適合當主視覺？",
  "這支影片在講什麼？",
  "這個企劃還缺什麼？",
  "整理目前討論",
];

function analysisText(asset: IntelligentAsset): string {
  return asset.human?.summary || asset.analysis?.summary || "這份素材還在建立理解資料。";
}

const FACT_LABELS: Array<[string, string]> = [
  ["headline", "主標題"],
  ["subtitle", "副標題"],
  ["date", "日期"],
  ["time", "時間"],
  ["location", "地點"],
  ["cta", "CTA"],
  ["qrCode", "QR Code"],
  ["logo", "Logo"],
  ["possibleUses", "可能用途"],
  ["readabilityIssues", "可讀性提醒"],
];

function analysisFacts(asset: IntelligentAsset): Array<[string, string]> {
  const structured = asset.analysis?.structuredData ?? {};
  const facts: Array<[string, string]> = [];
  for (const [key, label] of FACT_LABELS) {
    const value = structured[key];
    if (typeof value === "string" && value.trim()) {
      facts.push([label, value.trim()]);
      continue;
    }
    if (Array.isArray(value)) {
      const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 4);
      if (values.length) {
        facts.push([label, values.join("、")]);
        continue;
      }
    }
    if (value && typeof value === "object") {
      const objectValue = value as Record<string, unknown>;
      const textValue = typeof objectValue.text === "string" ? objectValue.text : typeof objectValue.present === "string" ? objectValue.present : "";
      if (textValue.trim()) facts.push([label, textValue.trim()]);
      else if (objectValue.present === true) facts.push([label, "已偵測"]);
    }
    if (facts.length >= 6) break;
  }
  return facts.slice(0, 6);
}

function sourceLocator(citation: ContextCitation): string | null {
  if (citation.locator?.kind === "video-segment") {
    return `${formatSeconds(citation.locator.startSeconds)}–${formatSeconds(citation.locator.endSeconds)}`;
  }
  if (citation.locator?.kind === "image-region") return citation.locator.region.label || "查看標記區域";
  if (citation.locator?.page) return `第 ${citation.locator.page} 頁`;
  return null;
}

function AssetCard({
  asset,
  job,
  selected,
  onSelect,
  onRetry,
  canManage,
  onUpdatePolicy,
  onUpdateHumanMetadata,
}: {
  asset: IntelligentAsset;
  job?: AssetAnalysisJob;
  selected: boolean;
  onSelect: () => void;
  onRetry?: () => void;
  canManage?: boolean;
  onUpdatePolicy?: (patch: { aiReadable: boolean; externalAiAllowed: boolean }) => Promise<void>;
  onUpdateHumanMetadata?: (input: { title?: string; summary?: string; tags?: string[] }) => Promise<void>;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [title, setTitle] = useState(asset.human?.title ?? "");
  const [summary, setSummary] = useState(asset.human?.summary ?? "");
  const [tags, setTags] = useState((asset.human?.tags ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(asset.human?.title ?? "");
    setSummary(asset.human?.summary ?? "");
    setTags((asset.human?.tags ?? []).join(", "));
  }, [asset.human?.title, asset.human?.summary, asset.human?.tags.join(",")]);

  const saveHuman = async () => {
    if (!onUpdateHumanMetadata || saving) return;
    setSaving(true);
    setActionError(null);
    try {
      await onUpdateHumanMetadata({
        title: title.trim() || undefined,
        summary: summary.trim() || undefined,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 30),
      });
    } catch {
      setActionError("保存失敗，請稍後再試。");
    } finally {
      setSaving(false);
    }
  };

  const changePolicy = async (patch: { aiReadable: boolean; externalAiAllowed: boolean }) => {
    if (!onUpdatePolicy) return;
    setActionError(null);
    try {
      await onUpdatePolicy(patch);
    } catch {
      setActionError("權限更新失敗，請稍後再試。");
    }
  };
  const facts = analysisFacts(asset);

  return (
    <article className={`asset-ai-asset-card ${selected ? "is-selected" : ""}`} data-testid={`ai-asset-${asset.id}`}>
      <button type="button" className="asset-ai-asset-main" onClick={onSelect} aria-pressed={selected}>
        <span className="asset-ai-asset-icon" aria-hidden>{asset.assetType === "video" ? "▶" : asset.assetType === "plan" ? "☷" : "▧"}</span>
        <span className="asset-ai-asset-copy">
          <strong>{asset.human?.title || asset.title}</strong>
          <small>{ASSET_TYPE_LABEL[asset.assetType]} · {ANALYSIS_STATUS_LABEL[asset.status]}{job && (job.status === "queued" || job.status === "processing") ? ` · ${job.progress}%` : ""} · {asset.aiReadable ? "AI 可讀" : "AI 已關閉"}</small>
          <span>{analysisText(asset)}</span>
          {(asset.human?.tags.length || asset.analysis?.topics.length) ? <em>{[...(asset.human?.tags ?? []), ...(asset.analysis?.topics ?? [])].slice(0, 4).join(" · ")}</em> : null}
          {facts.length > 0 && <dl className="asset-ai-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
        </span>
        <span className="asset-ai-check" aria-hidden>{selected ? "✓" : "＋"}</span>
      </button>
      <div className="asset-ai-asset-actions">
        {canManage && (asset.status === "failed" || asset.status === "partial") && onRetry ? <button type="button" className="asset-ai-retry" onClick={onRetry}>重試</button> : null}
        {canManage && (onUpdatePolicy || onUpdateHumanMetadata) ? <button type="button" className="asset-ai-settings-toggle" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>設定</button> : null}
      </div>
      {settingsOpen && canManage && (
        <div className="asset-ai-asset-settings" onClick={(event) => event.stopPropagation()}>
          {onUpdatePolicy && (
            <div className="asset-ai-policy">
              <label><input type="checkbox" checked={asset.aiReadable} onChange={(event) => void changePolicy({ aiReadable: event.target.checked, externalAiAllowed: event.target.checked && asset.externalAiAllowed })} /> 允許 AI 讀取</label>
              <label className={!asset.aiReadable ? "is-disabled" : ""}><input type="checkbox" checked={asset.externalAiAllowed} disabled={!asset.aiReadable} onChange={(event) => void changePolicy({ aiReadable: asset.aiReadable, externalAiAllowed: event.target.checked })} /> 允許外部核准 provider</label>
              <small>關閉 AI 讀取後，這份素材不會進入 Room Context。</small>
            </div>
          )}
          {onUpdateHumanMetadata && (
            <div className="asset-ai-human-form">
              <strong>人工修正</strong>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="顯示名稱（可選）" maxLength={240} aria-label="人工素材名稱" />
              <textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="人工摘要（優先於 AI 摘要）" maxLength={5000} rows={2} aria-label="人工素材摘要" />
              <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="標籤，以逗號分隔" maxLength={600} aria-label="人工素材標籤" />
              <button type="button" className="asset-ai-save-human" onClick={() => void saveHuman()} disabled={saving}>{saving ? "保存中…" : "保存人工標記"}</button>
            </div>
          )}
          {actionError && <small className="asset-ai-action-error" role="alert">{actionError}</small>}
        </div>
      )}
    </article>
  );
}

const ACTION_KIND: Record<AiProposal["type"], string> = {
  add_whiteboard_node: "白板",
  create_comment: "討論",
  create_poll: "投票",
  create_plan_draft: "企劃",
  create_schedule_event: "時程",
  create_task: "任務",
  propose_edit_text: "文案",
  propose_add_shape: "形狀",
  propose_move_item: "位置",
  propose_add_image: "圖片",
  imagine_image: "生圖",
  imagine_video: "生影",
  refuse_with_reason: "無法",
};

export function RoomAiSheet({ roomTitle, assets, jobs = [], selectedAssetIds = [], response, loading = false, error, onAsk, onClose, onFocus, onRetryAnalysis, onUpdatePolicy, onUpdateHumanMetadata, onApplyProposal, onRejectProposal, onCancel, canManage = false }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>(selectedAssetIds);
  const [showAssets, setShowAssets] = useState(false);
  const [proposalState, setProposalState] = useState<Record<string, { status: "preview" | "applied" | "rejected"; message?: string; confirm?: boolean }>>({});
  const proposals = useMemo(() => proposalsFromResponse(response), [response]);

  // The sheet stays mounted while App keeps the room workspace alive. Syncing
  // this prop prevents a citation/card opened from another branch from
  // inheriting the previous question's selection.
  useEffect(() => {
    setSelected(selectedAssetIds);
  }, [selectedAssetIds.join(",")]);

  useEffect(() => {
    setProposalState({});
  }, [response?.query, response?.answer?.text]);

  const selectedAssets = useMemo(() => assets.filter((asset) => selected.includes(asset.id)), [assets, selected]);
  const ask = async (value = query) => {
    const clean = value.trim();
    if (!clean || loading) return;
    try {
      await onAsk({ query: clean, selectedAssetIds: selected });
    } catch {
      // App owns the translated error state; the sheet must not create an
      // unhandled rejection when a preset is tapped on a mobile browser.
    }
  };
  const toggleAsset = (assetId: string) => setSelected((current) => current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId].slice(-8));

  return (
    <div className="asset-ai-scrim" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="asset-ai-sheet" role="dialog" aria-modal="true" aria-label="房間 AI" data-testid="room-ai-sheet">
        <div className="asset-ai-grip" aria-hidden />
        <header className="asset-ai-head">
          <div><span className="asset-ai-kicker">✦ 房間 AI</span><h2>問這間房的 AI</h2><p>{roomTitle}</p></div>
          <button type="button" className="asset-ai-close" onClick={onClose} aria-label="關閉 AI">×</button>
        </header>

        {selectedAssets.length > 0 && (
          <div className="asset-ai-selected" aria-label="已選素材">
            <span>正在詢問：</span>
            {selectedAssets.slice(0, 3).map((asset) => <button type="button" key={asset.id} onClick={() => toggleAsset(asset.id)}>{asset.human?.title || asset.title} ×</button>)}
            {selectedAssets.length > 3 && <small>＋{selectedAssets.length - 3} 項</small>}
          </div>
        )}

        <form className="asset-ai-form" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
          <textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="問這間房的 AI…" rows={2} maxLength={2000} aria-label="詢問房間 AI" disabled={loading} />
          {loading ? (
            <button type="button" className="asset-ai-submit" onClick={() => onCancel?.()} data-testid="room-ai-cancel">取消</button>
          ) : (
            <button type="submit" className="asset-ai-submit" disabled={!query.trim()}>送出</button>
          )}
        </form>
        <div className="asset-ai-presets" aria-label="快速提問">
          {PRESETS.map((preset) => <button type="button" key={preset} onClick={() => { setQuery(preset); void ask(preset); }}>{preset}</button>)}
        </div>

        {error && <p className="asset-ai-error" role="alert">{error}</p>}
        {(response?.agent?.status === "unconfigured" || (!response?.answer && response?.agent?.status === "unconfigured")) && (
          <p className="asset-ai-error" role="status" data-testid="room-ai-unconfigured">{AGENT_UNCONFIGURED_COPY}</p>
        )}
        {response?.answer ? (
          <article className="asset-ai-answer" data-testid="room-ai-answer">
            <p>{response.answer.text}</p>
            {response.agent?.status === "unconfigured" ? (
              <small data-testid="room-ai-unconfigured">{AGENT_UNCONFIGURED_COPY}</small>
            ) : response.agent?.status !== "ready" ? (
              <small>目前先顯示已找到的房間證據（AI provider 尚未連線）。</small>
            ) : null}
            {response.sources.length > 0 && <div className="asset-ai-citations"><strong>來源</strong>{response.sources.map((source) => {
              const citation = response.answer?.citations.find((item) => item.sourceId === source.sourceId) ?? source;
              return <button type="button" key={source.sourceId} onClick={() => onFocus(citation)}><span>{source.title}</span>{sourceLocator(citation) && <small>{sourceLocator(citation)}</small>}</button>;
            })}</div>}
            {onApplyProposal && proposals.length > 0 && (
              <div className="asset-ai-proposals" data-testid="ai-proposals">
                <strong>待審核提案</strong>
                <p className="asset-ai-proposals-hint">AI 不會自己寫入。預覽後再套用。</p>
                {proposals.map((proposal) => {
                  const state = proposalState[proposal.id] ?? { status: "preview" as const };
                  const sources = proposalShowsSources(proposal);
                  const videoSeconds = typeof proposal.payload.seconds === "number" ? proposal.payload.seconds : 6;
                  const videoRes = typeof proposal.payload.resolution === "string" ? proposal.payload.resolution : "720p";
                  const videoUsd = estimateImagineVideoUsd(videoSeconds, videoRes);
                  const apply = (extraConfirmed: boolean) => {
                    void Promise.resolve(onApplyProposal(proposal, extraConfirmed)).then((result) => {
                      if (result.ok) {
                        setProposalState((current) => ({ ...current, [proposal.id]: { status: "applied", message: result.message } }));
                        return;
                      }
                      if (result.reason === "needs-confirm") {
                        setProposalState((current) => ({ ...current, [proposal.id]: { status: "preview", confirm: true, message: result.message } }));
                        return;
                      }
                      setProposalState((current) => ({ ...current, [proposal.id]: { status: "preview", message: result.message } }));
                    });
                  };
                  return (
                    <div data-testid="room-ai-proposal-card" key={proposal.id}>
                    <article className={`asset-ai-proposal is-${state.status}`} data-testid="ai-proposal" data-proposal-id={proposal.id} data-proposal-type={proposal.type}>
                      <span className="asset-ai-proposal-kind">{ACTION_KIND[proposal.type]}</span>
                      <strong>{proposal.label}</strong>
                      {typeof proposal.payload.text === "string" && proposal.payload.text ? <p>{proposal.payload.text}</p> : null}
                      {typeof proposal.payload.body === "string" && proposal.payload.body ? <p>{proposal.payload.body}</p> : null}
                      {typeof proposal.payload.title === "string" && proposal.payload.title && proposal.payload.title !== proposal.label ? <p>{proposal.payload.title}</p> : null}
                      {sources.reason ? <p data-testid="ai-proposal-reason">{sources.reason}</p> : null}
                      {(sources.messages.length || sources.files.length || sources.nodes.length) ? (
                        <small data-testid="ai-proposal-sources">
                          {sources.messages.length ? `訊息 ${sources.messages.length}` : ""}
                          {sources.files.length ? ` 檔案 ${sources.files.length}` : ""}
                          {sources.nodes.length ? ` 節點 ${sources.nodes.length}` : ""}
                        </small>
                      ) : null}
                      {proposal.type === "imagine_image" ? <small>{IMAGINE_NOT_VERSION_COPY}</small> : null}
                      {proposal.type === "imagine_video" ? <small>預估 {Math.max(1, Math.min(15, Math.floor(videoSeconds)))} 秒 · 約 ${videoUsd.toFixed(2)}</small> : null}
                      {state.status === "applied" ? <small>{proposal.type === "imagine_image" ? IMAGINE_NOT_VERSION_COPY : "已採用。原稿沒有被改寫。"}</small> : null}
                      {state.status === "rejected" ? <small>已拒絕，沒有寫入。</small> : null}
                      {state.message && state.status === "preview" ? <small className="asset-ai-proposal-msg">{state.message}</small> : null}
                      {state.status === "preview" && proposal.type !== "refuse_with_reason" && (
                        <div className="asset-ai-proposal-actions">
                          {proposal.type === "imagine_video" && !state.confirm ? (
                            <button
                              type="button"
                              data-testid="room-ai-imagine-confirm"
                              onClick={() => apply(true)}
                            >
                              確認估價後生影
                            </button>
                          ) : (
                            <span data-testid="room-ai-apply">
                              <button
                                type="button"
                                data-testid="apply-proposal"
                                disabled={!onApplyProposal}
                                onClick={() => apply(Boolean(state.confirm) || proposal.type === "imagine_video")}
                              >
                                {proposal.requiresExtraConfirm && state.confirm
                                  ? (proposal.type === "imagine_video" ? "確定生影" : "確定建立企劃草稿")
                                  : "採用"}
                              </button>
                            </span>
                          )}
                          <button
                            type="button"
                            data-testid="reject-proposal"
                            onClick={() => {
                              onRejectProposal?.(proposal);
                              setProposalState((current) => ({ ...current, [proposal.id]: { status: "rejected" } }));
                            }}
                          >
                            拒絕
                          </button>
                        </div>
                      )}
                    </article>
                    </div>
                  );
                })}
              </div>
            )}
          </article>
        ) : response ? (
          <article className="asset-ai-answer"><p>目前已找到 {response.context.length} 項相關素材，但 AI provider 尚未回應。</p></article>
        ) : null}

        <section className="asset-ai-assets">
          <button type="button" className="asset-ai-assets-toggle" onClick={() => setShowAssets((value) => !value)} aria-expanded={showAssets}><span>素材理解</span><small>{assets.length} 項 · {showAssets ? "收起" : "展開"}</small></button>
          {showAssets && <div className="asset-ai-asset-list">{assets.slice(0, 24).map((asset) => <AssetCard
            key={asset.id}
            asset={asset}
            job={jobs.find((item) => item.assetId === asset.id && (item.status === "queued" || item.status === "processing"))}
            selected={selected.includes(asset.id)}
            onSelect={() => toggleAsset(asset.id)}
            onRetry={() => onRetryAnalysis?.(asset.id)}
            onUpdatePolicy={(patch) => onUpdatePolicy?.(asset.id, patch) ?? Promise.resolve()}
            onUpdateHumanMetadata={(input) => onUpdateHumanMetadata?.(asset.id, input) ?? Promise.resolve()}
            canManage={canManage}
          />)}{!assets.length && <p>目前還沒有可理解的素材。</p>}</div>}
        </section>
      </section>
    </div>
  );
}

export function AssetAiFab({ onClick }: { onClick: () => void }) {
  return <button type="button" className="asset-ai-fab" onClick={onClick} aria-label="問房間 AI" data-testid="room-ai-launcher">✦ <span>AI</span></button>;
}
