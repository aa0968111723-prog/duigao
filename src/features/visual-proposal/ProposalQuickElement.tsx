import { useRef } from "react";
import { INTAKE_PROFILES } from "../../components/UniversalIntake";
import { useProposalStore, type ProposalAuthor } from "./store";
import { FONT_STYLES, prepareImageFile } from "./helpers";
import { LiveColor, LiveRange } from "./controls-kit";
import type { ShowToast } from "../../toast";

type Props = {
  roomId: string;
  versionId: string;
  author: ProposalAuthor;
  showToast: ShowToast;
};

/**
 * Secondary controls: they only exist once an element is selected, which is why
 * the mobile dock can stay at five buttons. 移動 is the poster itself (drag /
 * pinch), so this pane covers 縮放 / 透明度 / 顯示 / 刪除 plus what the element type needs.
 */
export function ProposalQuickElement({ roomId, versionId, author, showToast }: Props) {
  const proposal = useProposalStore(roomId, versionId, author);
  const replaceRef = useRef<HTMLInputElement>(null);
  const selected = proposal.selectedItem;
  if (!selected) return null;

  const remove = () => {
    proposal.deleteItem(selected.id);
    showToast("已刪除元素", { action: { label: "復原", onClick: () => proposal.undo() } });
  };

  const replaceImage = async (files: FileList | null) => {
    const file = files?.[0];
    if (replaceRef.current) replaceRef.current.value = "";
    if (!file || selected.type !== "image") return;
    try {
      const prepared = await prepareImageFile(file);
      proposal.updateItem(selected.id, { imageDataUrl: prepared.dataUrl, name: prepared.name });
      showToast(prepared.note ?? "已換圖");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "換圖失敗", { tone: "error" });
    }
  };

  const kind = selected.type === "text" ? "文字" : selected.type === "image" ? "素材" : "色塊";

  return (
    <div className="pquick">
      <div className="pquick-head">
        <strong>{kind}</strong>
        <span className="proposal-muted">在文宣上拖曳可移動，兩指可縮放</span>
      </div>
      <div className="pquick-shortcuts" role="group" aria-label="選中元素">
        <span className="proposal-chip">移動</span>
        {selected.type === "image" && (
          <button type="button" className="proposal-chip" onClick={() => replaceRef.current?.click()}>
            換圖
          </button>
        )}
        <button type="button" className="proposal-chip proposal-danger" onClick={remove}>
          刪
        </button>
      </div>
      <input
        ref={replaceRef}
        className="proposal-file"
        type="file"
        accept={INTAKE_PROFILES.proposal.accept}
        onChange={(e) => void replaceImage(e.target.files)}
      />

      {selected.type === "text" && (
        <>
          <label className="proposal-field">
            <span>文字內容</span>
            <textarea
              value={selected.text}
              rows={2}
              aria-label="提案文字內容"
              onFocus={proposal.beginEdit}
              onChange={(e) => proposal.updateItemLive(selected.id, { text: e.target.value })}
              onBlur={proposal.endEdit}
            />
          </label>
          <div className="proposal-field">
            <span>字體感覺</span>
            <div className="proposal-chiprow" role="group" aria-label="字體風格">
              {FONT_STYLES.map((style) => (
                <button
                  key={style.key}
                  type="button"
                  className={`proposal-chip ${selected.fontStyle === style.key ? "is-on" : ""}`}
                  aria-pressed={selected.fontStyle === style.key}
                  onClick={() =>
                    proposal.updateItem(selected.id, {
                      fontStyle: style.key,
                      fontFamily: style.stack,
                      fontWeight: style.weight,
                    })
                  }
                >
                  {style.label}
                </button>
              ))}
            </div>
          </div>
          <div className="proposal-grid-2">
            <LiveColor
              label="文字色"
              ariaLabel="文字顏色"
              value={selected.color}
              onBegin={proposal.beginEdit}
              onLive={(v) => proposal.updateItemLive(selected.id, { color: v })}
              onEnd={proposal.endEdit}
            />
            <LiveRange
              label={`字級 ${selected.fontSize.toFixed(1)}`}
              ariaLabel="字體大小"
              value={selected.fontSize}
              min={2}
              max={16}
              step={0.25}
              onBegin={proposal.beginEdit}
              onLive={(v) => proposal.updateItemLive(selected.id, { fontSize: v })}
              onEnd={proposal.endEdit}
            />
          </div>
        </>
      )}

      {selected.type === "shape" && (
        <div className="proposal-grid-2">
          <LiveColor
            label="色塊顏色"
            ariaLabel="色塊顏色"
            value={selected.color}
            onBegin={proposal.beginEdit}
            onLive={(v) => proposal.updateItemLive(selected.id, { color: v })}
            onEnd={proposal.endEdit}
          />
          <LiveRange
            label={`高度 ${Math.round(selected.height)}%`}
            ariaLabel="色塊高度"
            value={selected.height}
            min={2}
            max={100}
            step={1}
            onBegin={proposal.beginEdit}
            onLive={(v) => proposal.updateItemLive(selected.id, { height: v })}
            onEnd={proposal.endEdit}
          />
        </div>
      )}

      <LiveRange
        label={`縮放 ${Math.round(selected.width)}%`}
        ariaLabel="元素大小"
        value={selected.width}
        min={5}
        max={100}
        step={1}
        onBegin={proposal.beginEdit}
        onLive={(v) => proposal.updateItemLive(selected.id, { width: v })}
        onEnd={proposal.endEdit}
      />
      <LiveRange
        label={`透明度 ${Math.round(selected.opacity * 100)}%`}
        ariaLabel="元素透明度"
        value={selected.opacity}
        min={0.05}
        max={1}
        step={0.05}
        onBegin={proposal.beginEdit}
        onLive={(v) => proposal.updateItemLive(selected.id, { opacity: v })}
        onEnd={proposal.endEdit}
      />

      <div className="pquick-actions">
        <button
          type="button"
          className="proposal-quiet"
          data-testid="poster-layer-duplicate"
          onClick={() => proposal.duplicateItem(selected.id)}
        >
          複製
        </button>
        <button
          type="button"
          className="proposal-quiet"
          data-testid="poster-layer-forward"
          onClick={() => proposal.reorderItem(selected.id, 1)}
        >
          上移
        </button>
        <button
          type="button"
          className="proposal-quiet"
          data-testid="poster-layer-back"
          onClick={() => proposal.reorderItem(selected.id, -1)}
        >
          下移
        </button>
        <button type="button" className="proposal-quiet" onClick={() => proposal.toggleItemVisible(selected.id)}>
          {selected.visible ? "暫時隱藏" : "重新顯示"}
        </button>
        <button type="button" className="proposal-quiet" onClick={() => proposal.resetItemPosition(selected.id)}>
          回到中央
        </button>
        <button type="button" className="proposal-danger" onClick={remove}>
          刪除
        </button>
      </div>
    </div>
  );
}
