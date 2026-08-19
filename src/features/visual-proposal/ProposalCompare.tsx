import { useProposalStore, type ProposalAuthor, type ProposalViewMode } from "./store";

type Props = {
  roomId: string;
  versionId: string;
  author: ProposalAuthor;
};

const MODES: { key: ProposalViewMode; label: string; hint: string }[] = [
  { key: "original", label: "原稿", hint: "完全乾淨的原始文宣" },
  { key: "proposal", label: "提案", hint: "只看這個提案的樣子" },
  { key: "compare", label: "對照", hint: "左邊原稿、右邊提案，拖滑桿比對" },
];

/** 原稿 / 提案 / 對照 — three taps, one slider, nothing else. */
export function ProposalCompare({ roomId, versionId, author }: Props) {
  const proposal = useProposalStore(roomId, versionId, author);
  const mode = proposal.viewMode;

  return (
    <div className="pcompare">
      <div className="pcompare-switch" role="group" aria-label="檢視方式">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            className={mode === m.key ? "is-on" : ""}
            aria-pressed={mode === m.key}
            onClick={() => proposal.setViewMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="proposal-muted">{MODES.find((m) => m.key === mode)?.hint}</p>
      {mode === "compare" && (
        <label className="proposal-field">
          <span>對照位置</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={proposal.compareSplit}
            aria-label="對照位置"
            onChange={(e) => proposal.setCompareSplit(Number(e.target.value))}
          />
        </label>
      )}
    </div>
  );
}
