/**
 * Poll create honesty. Question 1–240, options 2–6 after trim.
 * Empty / canned UI is not a poll. No new schema.
 */
export function boardPollTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim().slice(0, 240);
  return title.length ? title : null;
}

export function boardPollWrite(questionRaw: string, optionRaws: string[]): { question: string; options: string[] } | null {
  const question = boardPollTitle(questionRaw);
  if (!question) return null;
  const options = optionRaws.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 6);
  if (options.length < 2) return null;
  return { question, options };
}
