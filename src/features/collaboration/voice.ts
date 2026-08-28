import type { VoiceParticipant, VoiceSession } from "./types";

/**
 * Voice Room（PR-03，LiveKit）。
 *
 * create/join/leave/mute 已由 useVoiceRoom＋voice-token edge＋LiveKit
 * 落地（本旗標翻 true 的證據：scripts/e2e 的 voice 檢查與 harness 對
 * voice-token 真實源碼的簽名驗證）。實際可用性仍由 runtime health 決定
 * — LIVEKIT_* env 未設定的部署顯示誠實的「還在準備」文案，
 * voiceUnavailableReason 因此保留。
 */
export const VOICE_ROOM_MVP = true;

export type VoiceRoomApi = {
  create(roomId: string, title: string): Promise<VoiceSession>;
  join(sessionId: string, displayName: string): Promise<VoiceParticipant>;
  leave(sessionId: string): Promise<void>;
  mute(sessionId: string, muted: boolean): Promise<void>;
  listParticipants(sessionId: string): Promise<VoiceParticipant[]>;
};

export function voiceUnavailableReason(): string {
  return "語音房間還在準備，這一版先把討論和白板做好。";
}

export const voiceRoomApi: VoiceRoomApi = {
  async create() {
    throw new Error(voiceUnavailableReason());
  },
  async join() {
    throw new Error(voiceUnavailableReason());
  },
  async leave() {
    throw new Error(voiceUnavailableReason());
  },
  async mute() {
    throw new Error(voiceUnavailableReason());
  },
  async listParticipants() {
    return [];
  },
};
