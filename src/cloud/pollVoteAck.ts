/**
 * RLS can "succeed" a room_poll_votes UPSERT with zero rows.
 * App then keeps the chosen option locally, so the card looks voted.
 */
export function acceptPollVoteAck(data: unknown): { pollId: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Object.assign(new Error("VOTE_NOT_SAVED"), { code: "VOTE_NOT_SAVED" });
  }
  const raw = (data as { poll_id?: unknown }).poll_id;
  const pollId = typeof raw === "string" ? raw.trim() : "";
  if (!pollId) {
    throw Object.assign(new Error("VOTE_NOT_SAVED"), { code: "VOTE_NOT_SAVED" });
  }
  return { pollId };
}

export function isVoteNotSaved(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "VOTE_NOT_SAVED");
}
