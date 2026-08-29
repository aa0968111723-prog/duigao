import {
  answerRoomContext,
  requireDuigaoSignature,
  type RoomContextAnswer,
  type RoomContextAsk,
} from "./duigaoAgentAdapter";

/**
 * ai_os inbound adapter. Same HMAC as tku-zen-agent; different JSON field
 * names (`answer` vs `text`) are normalized by `answerRoomContext`.
 */

export async function verifyDuigaoSignature(input: {
  body: string;
  timestamp: string;
  signature: string;
  secret: string;
  nowSeconds?: number;
}): Promise<boolean> {
  try {
    await requireDuigaoSignature(input);
    return true;
  } catch {
    return false;
  }
}

export function answerDuigaoRoomContext(ask: RoomContextAsk, raw: Record<string, unknown> | null): RoomContextAnswer | null {
  return answerRoomContext(ask, raw);
}
