import { VERDICT_LABEL, VERDICTS, type Verdict } from "../../lib/types";
import { hotspotNote, type ReviewSummary as Summary } from "./summary";

/**
 * What the author sees when they come back.
 *
 * Numbers they could count themselves, plus the three stretches of the cut
 * where feedback actually piled up. Tapping a hotspot seeks there — the point
 * of the summary is to get the author to the right ten seconds, not to give
 * them a dashboard to admire.
 */

type Props = {
  label: string;
  summary: Summary;
  onSeek: (seconds: number) => void;
};

export function ReviewSummary({ label, summary, onSeek }: Props) {
  const anyVerdict = VERDICTS.some((v) => summary.verdicts[v] > 0);

  return (
    <section className="v-summary" aria-label={`${label}回饋摘要`}>
      <h3 className="v-summary-title">{label}回饋</h3>

      <ul className="v-summary-stats">
        {summary.viewers > 0 && (
          <li>
            <b>{summary.viewers}</b> 位夥伴已查看
          </li>
        )}
        <li>
          <b>{summary.comments}</b> 則時間回饋
        </li>
        {summary.reactions > 0 && (
          <li>
            <b>{summary.reactions}</b> 個快速反應
          </li>
        )}
        <li>
          <b>{summary.open}</b> 個待處理
        </li>
        {summary.done > 0 && (
          <li>
            <b>{summary.done}</b> 個已修改
          </li>
        )}
      </ul>

      {summary.hotspots.length > 0 && (
        <div className="v-summary-block">
          <span className="v-summary-label">集中位置</span>
          <ul className="v-summary-spots">
            {summary.hotspots.map((spot) => {
              const note = hotspotNote(spot);
              return (
                <li key={spot.start}>
                  <button type="button" className="v-summary-spot" onClick={() => onSeek(spot.start)}>
                    <b>{spot.label}</b>
                    <span>{note ?? `${spot.count} 則回饋`}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {anyVerdict && (
        <div className="v-summary-block">
          <span className="v-summary-label">看完的人怎麼說</span>
          <ul className="v-summary-verdicts">
            {VERDICTS.filter((v) => summary.verdicts[v] > 0).map((v: Verdict) => (
              <li key={v}>
                <span>{VERDICT_LABEL[v]}</span>
                <b>{summary.verdicts[v]}</b>
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.comments === 0 && summary.reactions === 0 && (
        <p className="v-summary-empty">還沒有人留下回饋。分享連結給夥伴就可以開始。</p>
      )}
    </section>
  );
}
