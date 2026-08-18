export class CloudError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "CloudError";
    this.code = code;
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** RPC raised a revision conflict for a proposal (a co-editor saved first). */
export function isRevisionConflict(err: unknown): boolean {
  return messageOf(err).includes("revision conflict");
}

/** Wrong / missing invite, or the room was archived. Shown as an expired-link message. */
export function isInvalidInvite(err: unknown): boolean {
  return messageOf(err).includes("invalid invite");
}
