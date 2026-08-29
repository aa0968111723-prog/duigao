/**
 * Decision create honesty. Title 1–240 after trim.
 * Empty / canned UI is not a decision. No new schema.
 */
export function decisionDraftTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim().slice(0, 240);
  return title.length ? title : null;
}

/** Board 「寫下決策」uses the same title rule. Empty / canned UI is not a decision. */
export function boardDecisionWrite(raw: string): { title: string; status: "decided" } | null {
  const title = decisionDraftTitle(raw);
  if (!title) return null;
  return { title, status: "decided" };
}
