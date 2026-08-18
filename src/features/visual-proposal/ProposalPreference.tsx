import { KEEP_ORIGINAL, type ProposalPref } from "../../lib/types";
import "./proposal.css";

export type PreferenceProps = {
  versionId: string;
  proposals: { id: string; name: string }[];
  prefs: ProposalPref[];
  userId: string;
  onChoose: (choice: string) => void;
};

/**
 * A tiny "how do we feel about this?" control: like a proposal, or keep the
 * original. Not a poll or leaderboard — just a soft signal with counts.
 */
export function ProposalPreference({ versionId, proposals, prefs, userId, onChoose }: PreferenceProps) {
  if (proposals.length === 0) return null;
  const forVersion = prefs.filter((p) => p.versionId === versionId);
  const mine = forVersion.find((p) => p.userId === userId)?.choice;
  const count = (choice: string) => forVersion.filter((p) => p.choice === choice).length;

  return (
    <div className="proposal-pref" role="group" aria-label="對提案表態">
      <span className="proposal-pref-title">大家比較喜歡？</span>
      <div className="proposal-pref-row">
        {proposals.map((p) => {
          const c = count(p.id);
          return (
            <button
              key={p.id}
              type="button"
              className={`proposal-pref-btn ${mine === p.id ? "is-on" : ""}`}
              aria-pressed={mine === p.id}
              onClick={() => onChoose(p.id)}
            >
              喜歡{p.name}
              {c > 0 ? ` · ${c}` : ""}
            </button>
          );
        })}
        <button
          type="button"
          className={`proposal-pref-btn ${mine === KEEP_ORIGINAL ? "is-on" : ""}`}
          aria-pressed={mine === KEEP_ORIGINAL}
          onClick={() => onChoose(KEEP_ORIGINAL)}
        >
          保留原稿
          {count(KEEP_ORIGINAL) > 0 ? ` · ${count(KEEP_ORIGINAL)}` : ""}
        </button>
      </div>
    </div>
  );
}
