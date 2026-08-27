import type { VoiceParticipant, VoiceSession } from "./types";

/**
 * Voice Room is an architecture boundary in 1.0.
 *
 * The schema (`voice_sessions`, `voice_session_participants`) and this
 * interface exist so a later line can plug in WebRTC without reshaping the
 * room. The feature flag stays off until create/join/leave/mute is stable.
 * Do not claim IMPLEMENTED while this flag is false.
 */
export const VOICE_ROOM_MVP = false;

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
