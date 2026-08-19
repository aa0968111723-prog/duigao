import { useRef } from "react";
import { useProposalStore, type BgImageFit, type GradientKind, type ProposalAuthor } from "./store";
import { prepareImageFile } from "./helpers";
import { LiveColor, LiveRange } from "./controls-kit";
import type { ShowToast } from "../../toast";

type Props = {
  roomId: string;
  versionId: string;
  author: ProposalAuthor;
  showToast?: ShowToast;
};

const GRADIENTS: { key: GradientKind; label: string }[] = [
  { key: "none", label: "無" },
  { key: "vertical", label: "上下" },
  { key: "horizontal", label: "左右" },
  { key: "diagonal", label: "對角" },
];

const FITS: { key: BgImageFit; label: string }[] = [
  { key: "cover", label: "填滿" },
  { key: "contain", label: "完整" },
];

export function ProposalBackgroundControls({ roomId, versionId, author, showToast }: Props) {
  const proposal = useProposalStore(roomId, versionId, author);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = proposal.active;
  if (!active) return null;
  const bg = active.background;

  const uploadBackground = async (files: FileList | null) => {
    const file = files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    try {
      const prepared = await prepareImageFile(file);
      proposal.setBackground({ imageDataUrl: prepared.dataUrl, imageOpacity: 1 });
      if (prepared.note) showToast?.(prepared.note);
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : "背景圖讀取失敗", { tone: "error" });
    }
  };

  return (
    <div className="proposal-bg">
      <div className="proposal-field">
        <span>底色漸層</span>
        <div className="proposal-chiprow" role="group" aria-label="背景漸層方向">
          {GRADIENTS.map((g) => (
            <button
              key={g.key}
              type="button"
              className={`proposal-chip ${bg.gradient === g.key ? "is-on" : ""}`}
              aria-pressed={bg.gradient === g.key}
              onClick={() => proposal.setBackground({ gradient: g.key, gradientOpacity: g.key === "none" ? 0 : Math.max(bg.gradientOpacity, 0.6) })}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {bg.gradient === "none" ? (
        <>
          <LiveColor
            label="純色"
            ariaLabel="背景純色"
            value={bg.color}
            onBegin={proposal.beginEdit}
            onLive={(v) => proposal.setBackgroundLive({ color: v })}
            onEnd={proposal.endEdit}
          />
          <LiveRange
            label={`色彩濃度 ${Math.round(bg.colorOpacity * 100)}%`}
            ariaLabel="背景色濃度"
            value={bg.colorOpacity}
            min={0}
            max={1}
            step={0.05}
            onBegin={proposal.beginEdit}
            onLive={(v) => proposal.setBackgroundLive({ colorOpacity: v })}
            onEnd={proposal.endEdit}
          />
        </>
      ) : (
        <>
          <div className="proposal-grid-2">
            <LiveColor
              label="起始色"
              ariaLabel="漸層起始色"
              value={bg.gradientFrom}
              onBegin={proposal.beginEdit}
              onLive={(v) => proposal.setBackgroundLive({ gradientFrom: v })}
              onEnd={proposal.endEdit}
            />
            <LiveColor
              label="結束色"
              ariaLabel="漸層結束色"
              value={bg.gradientTo}
              onBegin={proposal.beginEdit}
              onLive={(v) => proposal.setBackgroundLive({ gradientTo: v })}
              onEnd={proposal.endEdit}
            />
          </div>
          <LiveRange
            label={`漸層濃度 ${Math.round(bg.gradientOpacity * 100)}%`}
            ariaLabel="漸層濃度"
            value={bg.gradientOpacity}
            min={0}
            max={1}
            step={0.05}
            onBegin={proposal.beginEdit}
            onLive={(v) => proposal.setBackgroundLive({ gradientOpacity: v })}
            onEnd={proposal.endEdit}
          />
        </>
      )}

      <div className="proposal-inline-actions">
        <button type="button" className="proposal-action" onClick={() => fileRef.current?.click()}>
          {bg.imageDataUrl ? "換背景圖" : "加背景圖"}
        </button>
        {bg.imageDataUrl && (
          <button type="button" className="proposal-quiet" onClick={proposal.removeBackgroundImage}>
            移除背景圖
          </button>
        )}
        <input
          ref={fileRef}
          className="proposal-file"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          onChange={(e) => void uploadBackground(e.target.files)}
        />
      </div>

      {bg.imageDataUrl && (
        <>
          <div className="proposal-field">
            <span>背景圖顯示</span>
            <div className="proposal-chiprow" role="group" aria-label="背景圖顯示方式">
              {FITS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`proposal-chip ${bg.imageFit === f.key ? "is-on" : ""}`}
                  aria-pressed={bg.imageFit === f.key}
                  onClick={() => proposal.setBackground({ imageFit: f.key })}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <LiveRange
            label={`背景圖透明度 ${Math.round(bg.imageOpacity * 100)}%`}
            ariaLabel="背景圖透明度"
            value={bg.imageOpacity}
            min={0.1}
            max={1}
            step={0.05}
            onBegin={proposal.beginEdit}
            onLive={(v) => proposal.setBackgroundLive({ imageOpacity: v })}
            onEnd={proposal.endEdit}
          />
        </>
      )}
    </div>
  );
}
