import { useRef } from "react";
import { useProposalStore, type ProposalAlign } from "./store";
import "./proposal.css";

type Props = {
  roomId: string;
  versionId: string;
  authorName: string;
  compact?: boolean;
};

const FONTS = [
  { label: "現代黑體", value: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif' },
  { label: "系統黑體", value: 'system-ui, -apple-system, "PingFang TC", sans-serif' },
  { label: "明體 / 襯線", value: '"Noto Serif TC", "Songti TC", "PMingLiU", serif' },
  { label: "手寫感", value: '"DFKai-SB", "BiauKai", cursive' },
] as const;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ProposalControls({ roomId, versionId, authorName, compact }: Props) {
  const proposal = useProposalStore(roomId, versionId, authorName);
  const materialRef = useRef<HTMLInputElement>(null);
  const backgroundRef = useRef<HTMLInputElement>(null);
  const active = proposal.active;
  const selected = proposal.selectedItem;

  const uploadMaterial = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    proposal.addImage(await fileToDataUrl(file), file.name);
    if (materialRef.current) materialRef.current.value = "";
  };

  const uploadBackground = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    proposal.setBackground({ imageDataUrl: await fileToDataUrl(file), imageOpacity: 1 });
    if (backgroundRef.current) backgroundRef.current.value = "";
  };

  return (
    <section className={`proposal-controls ${compact ? "is-compact" : ""}`}>
      <div className="proposal-controls-head">
        <div>
          <strong>視覺提案</strong>
          <p>只做模擬，不會修改原始文宣。</p>
        </div>
        {active && (
          <div className="proposal-view-switch" aria-label="原稿與提案切換">
            <button type="button" className={!proposal.visible ? "is-on" : ""} onClick={() => proposal.setVisible(false)}>
              原稿
            </button>
            <button type="button" className={proposal.visible ? "is-on" : ""} onClick={() => proposal.setVisible(true)}>
              提案
            </button>
          </div>
        )}
      </div>

      {!proposal.hydrated && <p className="proposal-muted">正在載入這台裝置的提案…</p>}

      {proposal.hydrated && !active ? (
        <button type="button" className="proposal-primary" onClick={proposal.create}>
          ＋ 建立這一版的視覺提案
        </button>
      ) : null}

      {active && (
        <>
          <div className="proposal-doc-row">
            <div className="proposal-docs" aria-label="提案版本">
              {proposal.docs.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  className={doc.id === active.id ? "is-on" : ""}
                  onClick={() => proposal.selectProposal(doc.id)}
                >
                  {doc.name}
                </button>
              ))}
            </div>
            <button type="button" className="proposal-icon-action" onClick={proposal.create} title="新增另一個提案">
              ＋
            </button>
          </div>

          <div className="proposal-action-row">
            <button type="button" className="proposal-action" onClick={proposal.addText}>
              Aa 文案 / 字體
            </button>
            <button type="button" className="proposal-action" onClick={() => materialRef.current?.click()}>
              ＋ 素材
            </button>
            <input
              ref={materialRef}
              className="proposal-file"
              type="file"
              accept="image/*"
              onChange={(event) => void uploadMaterial(event.target.files)}
            />
            <button
              type="button"
              className={`proposal-action ${proposal.editing ? "is-on" : ""}`}
              onClick={() => proposal.setEditing(!proposal.editing)}
            >
              {proposal.editing ? "完成擺放" : "移動素材"}
            </button>
          </div>

          <details className="proposal-section" open={!compact}>
            <summary>背景模擬</summary>
            <div className="proposal-section-body">
              <label className="proposal-field proposal-field-inline">
                <span>背景色</span>
                <input
                  type="color"
                  value={active.background.color}
                  onChange={(event) => proposal.setBackground({ color: event.target.value })}
                />
              </label>
              <label className="proposal-field">
                <span>色彩覆蓋 {Math.round(active.background.colorOpacity * 100)}%</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={active.background.colorOpacity}
                  onChange={(event) => proposal.setBackground({ colorOpacity: Number(event.target.value) })}
                />
              </label>
              <div className="proposal-inline-actions">
                <button type="button" className="proposal-action" onClick={() => backgroundRef.current?.click()}>
                  換背景圖預覽
                </button>
                {active.background.imageDataUrl && (
                  <button type="button" className="proposal-quiet" onClick={proposal.removeBackgroundImage}>
                    移除背景圖
                  </button>
                )}
                <input
                  ref={backgroundRef}
                  className="proposal-file"
                  type="file"
                  accept="image/*"
                  onChange={(event) => void uploadBackground(event.target.files)}
                />
              </div>
              {active.background.imageDataUrl && (
                <label className="proposal-field">
                  <span>背景圖透明度 {Math.round(active.background.imageOpacity * 100)}%</span>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={active.background.imageOpacity}
                    onChange={(event) => proposal.setBackground({ imageOpacity: Number(event.target.value) })}
                  />
                </label>
              )}
            </div>
          </details>

          <div className="proposal-selected">
            {!selected ? (
              <p className="proposal-muted">點「Aa 文案 / 字體」或「＋ 素材」新增，再到文宣上拖曳位置。</p>
            ) : selected.type === "text" ? (
              <>
                <div className="proposal-selected-title">
                  <strong>文案試看</strong>
                  <button type="button" className="proposal-danger" onClick={() => proposal.deleteItem(selected.id)}>
                    刪除
                  </button>
                </div>
                <label className="proposal-field">
                  <span>模擬文案</span>
                  <textarea
                    value={selected.text}
                    rows={3}
                    onChange={(event) => proposal.updateItem(selected.id, { text: event.target.value })}
                  />
                </label>
                <div className="proposal-grid-2">
                  <label className="proposal-field">
                    <span>字體</span>
                    <select
                      value={selected.fontFamily}
                      onChange={(event) => proposal.updateItem(selected.id, { fontFamily: event.target.value })}
                    >
                      {FONTS.map((font) => (
                        <option key={font.label} value={font.value}>
                          {font.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="proposal-field">
                    <span>字重</span>
                    <select
                      value={selected.fontWeight}
                      onChange={(event) => proposal.updateItem(selected.id, { fontWeight: Number(event.target.value) })}
                    >
                      <option value={400}>一般</option>
                      <option value={500}>中等</option>
                      <option value={700}>粗體</option>
                      <option value={900}>特粗</option>
                    </select>
                  </label>
                </div>
                <label className="proposal-field">
                  <span>字體大小 {selected.fontSize.toFixed(1)}</span>
                  <input
                    type="range"
                    min={2}
                    max={14}
                    step={0.25}
                    value={selected.fontSize}
                    onChange={(event) => proposal.updateItem(selected.id, { fontSize: Number(event.target.value) })}
                  />
                </label>
                <label className="proposal-field">
                  <span>文字區寬度 {Math.round(selected.width)}%</span>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={1}
                    value={selected.width}
                    onChange={(event) => proposal.updateItem(selected.id, { width: Number(event.target.value) })}
                  />
                </label>
                <div className="proposal-grid-2">
                  <label className="proposal-field proposal-field-inline">
                    <span>文字色</span>
                    <input
                      type="color"
                      value={selected.color}
                      onChange={(event) => proposal.updateItem(selected.id, { color: event.target.value })}
                    />
                  </label>
                  <label className="proposal-field proposal-field-inline">
                    <span>文字底色</span>
                    <input
                      type="color"
                      value={selected.backdropColor}
                      onChange={(event) => proposal.updateItem(selected.id, { backdropColor: event.target.value })}
                    />
                  </label>
                </div>
                <label className="proposal-field">
                  <span>底色遮罩 {Math.round(selected.backdropOpacity * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={selected.backdropOpacity}
                    onChange={(event) => proposal.updateItem(selected.id, { backdropOpacity: Number(event.target.value) })}
                  />
                </label>
                <div className="proposal-align" aria-label="文字對齊">
                  {(["left", "center", "right"] as ProposalAlign[]).map((align) => (
                    <button
                      key={align}
                      type="button"
                      className={selected.align === align ? "is-on" : ""}
                      onClick={() => proposal.updateItem(selected.id, { align })}
                    >
                      {align === "left" ? "靠左" : align === "center" ? "置中" : "靠右"}
                    </button>
                  ))}
                </div>
                <label className="proposal-field">
                  <span>旋轉 {selected.rotation}°</span>
                  <input
                    type="range"
                    min={-30}
                    max={30}
                    step={1}
                    value={selected.rotation}
                    onChange={(event) => proposal.updateItem(selected.id, { rotation: Number(event.target.value) })}
                  />
                </label>
              </>
            ) : (
              <>
                <div className="proposal-selected-title">
                  <strong>素材：{selected.name}</strong>
                  <button type="button" className="proposal-danger" onClick={() => proposal.deleteItem(selected.id)}>
                    刪除
                  </button>
                </div>
                <label className="proposal-field">
                  <span>尺寸 {Math.round(selected.width)}%</span>
                  <input
                    type="range"
                    min={8}
                    max={100}
                    step={1}
                    value={selected.width}
                    onChange={(event) => proposal.updateItem(selected.id, { width: Number(event.target.value) })}
                  />
                </label>
                <label className="proposal-field">
                  <span>透明度 {Math.round(selected.opacity * 100)}%</span>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={selected.opacity}
                    onChange={(event) => proposal.updateItem(selected.id, { opacity: Number(event.target.value) })}
                  />
                </label>
                <label className="proposal-field">
                  <span>旋轉 {selected.rotation}°</span>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={1}
                    value={selected.rotation}
                    onChange={(event) => proposal.updateItem(selected.id, { rotation: Number(event.target.value) })}
                  />
                </label>
              </>
            )}
          </div>

          <p className="proposal-local-note">目前提案先保存在這台裝置；後續雲端房間會再把它納入多人同步。</p>
        </>
      )}
    </section>
  );
}
