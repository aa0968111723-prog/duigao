/**
 * Design Intelligence — 提案面板（PR-DI-04）
 *
 * 任務書第十四節：「AI 不能佔據主畫面。AI 面板必須是情境式的。」
 * 所以這個元件**永遠是疊在作品上的一層**，而且：
 *   - 手機是底部抽屜，可以收成一條，主畫面永遠看得到。
 *   - 平板是側邊分割，寬度有上限。
 *
 * 所有的版面與狀態決策都在 `proposalView.ts` 裡（純函式、有測試）。
 * 這個檔案只負責把那些決策畫出來 —— 這樣「面板會不會蓋住主畫面」
 * 這種事才有辦法用斷言驗，而不是只能靠肉眼。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyGate,
  applyPreviewText,
  layoutFor,
  nextAlternativeIndex,
  panelStateFor,
  swipeIntent,
  type ViewportInfo,
} from "./proposalView";
import type { DesignProposal, Diagnostic } from "./types";

type Props = {
  proposal: DesignProposal;
  viewport: ViewportInfo;
  /** 使用者按下「套用這個方案」。**元件自己不套用任何東西。** */
  onApply: (alternativeId: string) => void;
  onDismiss: () => void;
  onRetry?: () => void;
};

const SEVERITY_LABEL: Record<Diagnostic["severity"], string> = {
  blocker: "必須修",
  major: "重要",
  minor: "建議",
  nit: "細節",
};

export function DesignProposalPanel({ proposal, viewport, onApply, onDismiss, onRetry }: Props) {
  const layout = useMemo(() => layoutFor(viewport), [viewport]);
  const state = useMemo(() => panelStateFor(proposal), [proposal]);
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);

  // 提案換了就回到第一個方案 —— 停在第 3 個然後換一份只有 1 個方案的提案，
  // 使用者會看到空白。
  useEffect(() => {
    setIndex(0);
  }, [proposal.id]);

  const alternatives = proposal.alternatives;
  const active = alternatives[Math.min(index, Math.max(0, alternatives.length - 1))] ?? null;
  const gate = applyGate(proposal, active?.id ?? null);
  const preview = applyPreviewText(proposal, active?.id ?? null);

  const drag = useRef<{ x: number; y: number; at: number } | null>(null);
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    drag.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
  }, []);
  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const start = drag.current;
      drag.current = null;
      if (!start || alternatives.length < 2) return;
      const intent = swipeIntent({
        dx: event.clientX - start.x,
        dy: event.clientY - start.y,
        elapsedMs: event.timeStamp - start.at,
      });
      if (intent) setIndex((current) => nextAlternativeIndex(current, alternatives.length, intent));
    },
    [alternatives.length],
  );

  const isSheet = layout.kind === "sheet";
  const style: React.CSSProperties = isSheet
    ? {
        height: expanded
          ? `${Math.round(viewport.height * layout.maxHeightRatio)}px`
          : `${layout.peekPx}px`,
      }
    : { width: `${layout.widthPx}px` };

  return (
    <aside
      className={`di-panel di-panel--${layout.kind}`}
      style={style}
      data-testid="di-panel"
      data-layout={layout.kind}
      data-expanded={isSheet ? String(expanded) : "true"}
      aria-label="設計建議"
    >
      <header className="di-panel__bar">
        {isSheet ? (
          <button
            type="button"
            className="di-panel__handle"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            data-testid="di-panel-handle"
          >
            <span className="di-panel__grip" aria-hidden="true" />
            <span className="di-panel__title">
              設計建議
              {state.kind === "result" && state.diagnostics.length > 0
                ? `（${state.diagnostics.length}）`
                : ""}
            </span>
          </button>
        ) : (
          <h2 className="di-panel__title">設計建議</h2>
        )}
        <button type="button" className="di-panel__close" onClick={onDismiss} aria-label="關閉設計建議">
          ✕
        </button>
      </header>

      {(!isSheet || expanded) && (
        <div className="di-panel__body">
          {state.kind === "analyzing" && (
            <p className="di-panel__note" role="status">
              {state.note}
            </p>
          )}

          {state.kind === "notice" && (
            <div className="di-panel__note">
              <h3>{state.title}</h3>
              <p>{state.detail}</p>
            </div>
          )}

          {state.kind === "failed" && (
            <div className="di-panel__note di-panel__note--failed" role="alert">
              <h3>{state.title}</h3>
              {/* 失敗原因照實顯示。用「請稍後再試」蓋掉真正的錯誤，
                  使用者就沒辦法判斷是自己的問題還是服務的問題。 */}
              <p data-testid="di-failure-detail">{state.detail}</p>
              {state.retryable && onRetry && (
                <button type="button" onClick={onRetry}>
                  再試一次
                </button>
              )}
            </div>
          )}

          {state.kind === "result" && (
            <>
              {proposal.risks.length > 0 && (
                <ul className="di-panel__risks" data-testid="di-risks">
                  {proposal.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              )}

              <section aria-label="診斷">
                <ol className="di-panel__diagnostics" data-testid="di-diagnostics">
                  {state.diagnostics.map((diagnostic) => (
                    <li key={diagnostic.id} data-severity={diagnostic.severity}>
                      <p className="di-diagnostic__head">
                        <span className="di-diagnostic__severity">
                          {SEVERITY_LABEL[diagnostic.severity]}
                        </span>
                        <span className="di-diagnostic__where">{diagnostic.location}</span>
                        {/* 量出來的與模型說的要分得出來 —— 這是使用者判斷
                            要不要照做的重要依據。 */}
                        {diagnostic.measured && (
                          <span className="di-diagnostic__measured" title="這條是量出來的">
                            量測
                          </span>
                        )}
                      </p>
                      <p className="di-diagnostic__issue">{diagnostic.issue}</p>
                      <p className="di-diagnostic__impact">{diagnostic.impact}</p>
                      <p className="di-diagnostic__evidence">{diagnostic.evidence}</p>
                      <p className="di-diagnostic__fix">{diagnostic.recommendation}</p>
                    </li>
                  ))}
                </ol>
              </section>

              {alternatives.length > 0 && active && (
                <section
                  aria-label="方案"
                  className="di-panel__alternatives"
                  onPointerDown={onPointerDown}
                  onPointerUp={onPointerUp}
                  data-testid="di-alternatives"
                >
                  {/* 手機一次只顯示一個方案（任務書第十五節）。
                      平板的分割欄同樣一次一個 —— 380px 寬放不下三欄，
                      硬塞會讓每一欄都讀不了。 */}
                  <article className="di-alternative" data-testid="di-alternative" data-index={index}>
                    <h3>{active.name}</h3>
                    <ul className="di-alternative__changes">
                      {active.changes.map((change) => (
                        <li key={`${change.target}-${change.change}`}>
                          <strong>{change.target}</strong>
                          <span>{change.change}</span>
                          <em>{change.reason}</em>
                        </li>
                      ))}
                    </ul>
                    {active.advantages.length > 0 && (
                      <ul className="di-alternative__pros">
                        {active.advantages.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    )}
                    {active.tradeoffs.length > 0 && (
                      <ul className="di-alternative__cons">
                        {active.tradeoffs.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </article>

                  {alternatives.length > 1 && (
                    <nav className="di-alternative__nav" aria-label="切換方案">
                      <button
                        type="button"
                        onClick={() => setIndex((c) => nextAlternativeIndex(c, alternatives.length, "prev"))}
                        disabled={index === 0}
                        aria-label="上一個方案"
                        data-testid="di-prev"
                      >
                        ‹
                      </button>
                      <span data-testid="di-page">
                        {index + 1} / {alternatives.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => setIndex((c) => nextAlternativeIndex(c, alternatives.length, "next"))}
                        disabled={index === alternatives.length - 1}
                        aria-label="下一個方案"
                        data-testid="di-next"
                      >
                        ›
                      </button>
                    </nav>
                  )}
                </section>
              )}

              <footer className="di-panel__apply">
                {/* 按下去之前就把會改什麼、怎麼還原說清楚。
                    使用者的原稿是他們花時間做的。 */}
                {preview.changeCount > 0 && (
                  <p className="di-apply__preview" data-testid="di-apply-preview">
                    會改 {preview.changeCount} 處。{preview.revertNote}
                  </p>
                )}
                <button
                  type="button"
                  className="di-apply__button"
                  disabled={!gate.enabled}
                  onClick={() => active && onApply(active.id)}
                  data-testid="di-apply"
                >
                  套用這個方案
                </button>
                {!gate.enabled && (
                  <p className="di-apply__reason" data-testid="di-apply-reason">
                    {gate.reason}
                  </p>
                )}
              </footer>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
