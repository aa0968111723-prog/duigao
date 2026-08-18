import { useProposalStore } from "./store";
import { FONT_STYLES, fontStyleByKey } from "./helpers";
import { LiveColor, LiveRange } from "./controls-kit";
import type { ShowToast } from "../../toast";

type Props = {
  roomId: string;
  versionId: string;
  authorName: string;
  showToast?: ShowToast;
};

export function ProposalElementControls({ roomId, versionId, authorName, showToast }: Props) {
  const proposal = useProposalStore(roomId, versionId, authorName);
  const selected = proposal.selectedItem;

  if (!selected) {
    return <p className="proposal-muted">點文宣上的元素來調整，或先用上方按鈕新增文字 / 素材。</p>;
  }

  const remove = () => {
    proposal.deleteItem(selected.id);
    showToast?.("已刪除元素", { action: { label: "復原", onClick: () => proposal.undo() } });
  };

  const common = (
    <div className="proposal-elem-actions">
      <button type="button" className="proposal-quiet" onClick={() => proposal.duplicateItem(selected.id)}>
        複製
      </button>
      <button type="button" className="proposal-quiet" onClick={() => proposal.reorderItem(selected.id, 1)} aria-label="上移一層">
        上移一層
      </button>
      <button type="button" className="proposal-quiet" onClick={() => proposal.reorderItem(selected.id, -1)} aria-label="下移一層">
        下移一層
      </button>
      <button type="button" className="proposal-quiet" onClick={() => proposal.resetItemPosition(selected.id)}>
        重設位置
      </button>
      <button type="button" className="proposal-danger" onClick={remove}>
        刪除
      </button>
    </div>
  );

  if (selected.type === "image") {
    return (
      <div className="proposal-elem">
        <div className="proposal-selected-title">
          <strong>素材：{selected.name}</strong>
        </div>
        <LiveRange
          label={`尺寸 ${Math.round(selected.width)}%`}
          ariaLabel="素材尺寸"
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
          ariaLabel="素材透明度"
          value={selected.opacity}
          min={0.1}
          max={1}
          step={0.05}
          onBegin={proposal.beginEdit}
          onLive={(v) => proposal.updateItemLive(selected.id, { opacity: v })}
          onEnd={proposal.endEdit}
        />
        <LiveRange
          label={`旋轉 ${Math.round(selected.rotation)}°`}
          ariaLabel="素材旋轉角度"
          value={selected.rotation}
          min={-180}
          max={180}
          step={1}
          onBegin={proposal.beginEdit}
          onLive={(v) => proposal.updateItemLive(selected.id, { rotation: v })}
          onEnd={proposal.endEdit}
        />
        {common}
      </div>
    );
  }

  return (
    <div className="proposal-elem">
      <label className="proposal-field">
        <span>模擬文案</span>
        <textarea
          value={selected.text}
          rows={2}
          aria-label="模擬文案內容"
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

      <div className="proposal-align" aria-label="文字對齊">
        {(["left", "center", "right"] as const).map((align) => (
          <button
            key={align}
            type="button"
            className={selected.align === align ? "is-on" : ""}
            aria-pressed={selected.align === align}
            onClick={() => proposal.updateItem(selected.id, { align })}
          >
            {align === "left" ? "靠左" : align === "center" ? "置中" : "靠右"}
          </button>
        ))}
      </div>

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
      <LiveRange
        label={`文字區寬度 ${Math.round(selected.width)}%`}
        ariaLabel="文字區寬度"
        value={selected.width}
        min={20}
        max={100}
        step={1}
        onBegin={proposal.beginEdit}
        onLive={(v) => proposal.updateItemLive(selected.id, { width: v })}
        onEnd={proposal.endEdit}
      />
      <div className="proposal-grid-2">
        <LiveColor
          label="文字色"
          ariaLabel="文字顏色"
          value={selected.color}
          onBegin={proposal.beginEdit}
          onLive={(v) => proposal.updateItemLive(selected.id, { color: v })}
          onEnd={proposal.endEdit}
        />
        <LiveColor
          label="遮罩色"
          ariaLabel="文字遮罩顏色"
          value={selected.backdropColor}
          onBegin={proposal.beginEdit}
          onLive={(v) => proposal.updateItemLive(selected.id, { backdropColor: v })}
          onEnd={proposal.endEdit}
        />
      </div>
      <LiveRange
        label={`遮罩濃度 ${Math.round(selected.backdropOpacity * 100)}%`}
        ariaLabel="文字遮罩濃度"
        value={selected.backdropOpacity}
        min={0}
        max={1}
        step={0.05}
        onBegin={proposal.beginEdit}
        onLive={(v) => proposal.updateItemLive(selected.id, { backdropOpacity: v })}
        onEnd={proposal.endEdit}
      />
      {selected.backdropOpacity > 0 && (
        <div className="proposal-grid-2">
          <LiveRange
            label={`遮罩留白 ${selected.backdropPadding.toFixed(1)}`}
            ariaLabel="遮罩留白"
            value={selected.backdropPadding}
            min={0}
            max={2}
            step={0.1}
            onBegin={proposal.beginEdit}
            onLive={(v) => proposal.updateItemLive(selected.id, { backdropPadding: v })}
            onEnd={proposal.endEdit}
          />
          <LiveRange
            label={`遮罩圓角 ${Math.round(selected.backdropRadius)}`}
            ariaLabel="遮罩圓角"
            value={selected.backdropRadius}
            min={0}
            max={40}
            step={1}
            onBegin={proposal.beginEdit}
            onLive={(v) => proposal.updateItemLive(selected.id, { backdropRadius: v })}
            onEnd={proposal.endEdit}
          />
        </div>
      )}
      <LiveRange
        label={`旋轉 ${Math.round(selected.rotation)}°`}
        ariaLabel="文字旋轉角度"
        value={selected.rotation}
        min={-30}
        max={30}
        step={1}
        onBegin={proposal.beginEdit}
        onLive={(v) => proposal.updateItemLive(selected.id, { rotation: v })}
        onEnd={proposal.endEdit}
      />
      <p className="proposal-muted proposal-hint-line">目前字體感覺：{fontStyleByKey(selected.fontStyle).label}</p>
      {common}
    </div>
  );
}
