/**
 * LiveKit 連線的薄封裝（PR-03）。
 *
 * livekit-client 約 200KB min — 與 peerjs 同一套紀律：動態載入，
 * 只有真的按下「加入語音」的那一刻才付這筆；Home 首屏與純文字討論
 * 完全不揹。載入失敗（離線）走誠實錯誤，不白屏。
 *
 * 這一層只做三件事：connect（含開麥）、mute、disconnect，加上把
 * LiveKit 的參與者事件折成一個簡單的 roster 回呼。誰在房裡、誰在
 * 講話，以 LiveKit 的即時事實為準；voice_session_participants 的
 * DB 列是給「沒加入語音的人也看得到有語音在進行」的持久紀錄，
 * 由 useVoiceRoom 維護，不在這裡。
 */

export type VoiceParticipantInfo = {
  identity: string;
  name: string;
  speaking: boolean;
  muted: boolean;
  isLocal: boolean;
};

export type VoiceConnection = {
  setMuted: (muted: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
};

export type ConnectVoiceInput = {
  url: string;
  token: string;
  onRoster: (participants: VoiceParticipantInfo[]) => void;
  /** 連線終止（主動離開以外的任何原因）。UI 據此回到可重連狀態。 */
  onDisconnected: (reason: string) => void;
};

type LiveKitModule = typeof import("livekit-client");

let liveKitModule: LiveKitModule | null = null;
async function loadLiveKit(): Promise<LiveKitModule> {
  if (!liveKitModule) liveKitModule = await import("livekit-client");
  return liveKitModule;
}

export async function connectVoice(input: ConnectVoiceInput): Promise<VoiceConnection> {
  const { Room, RoomEvent, Track } = await loadLiveKit();
  const room = new Room({
    // 音訊房：自動訂閱即可，參與者數量小（房間協作規模），不需要
    // selective subscription 的複雜度。
    adaptiveStream: false,
    dynacast: false,
  });

  let intentionalDisconnect = false;

  const snapshotRoster = () => {
    const list: VoiceParticipantInfo[] = [];
    const local = room.localParticipant;
    list.push({
      identity: local.identity,
      name: local.name || local.identity,
      speaking: local.isSpeaking,
      muted: !local.isMicrophoneEnabled,
      isLocal: true,
    });
    for (const participant of room.remoteParticipants.values()) {
      const micPub = participant.getTrackPublication(Track.Source.Microphone);
      list.push({
        identity: participant.identity,
        name: participant.name || participant.identity,
        speaking: participant.isSpeaking,
        muted: micPub ? micPub.isMuted : true,
        isLocal: false,
      });
    }
    input.onRoster(list);
  };

  const rosterEvents = [
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.ActiveSpeakersChanged,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
  ] as const;
  for (const event of rosterEvents) {
    // 單一 snapshot 函式吃所有事件：roster 永遠是全量重建，不做增量
    // 補丁 — 參與者數量小，正確性比省事件重要。
    room.on(event, snapshotRoster);
  }

  room.on(RoomEvent.Disconnected, (reason) => {
    if (!intentionalDisconnect) input.onDisconnected(String(reason ?? "disconnected"));
  });

  await room.connect(input.url, input.token);
  // 開麥失敗（權限拒絕）要讓呼叫端知道 — 連上了但不能講話不是「已加入」。
  await room.localParticipant.setMicrophoneEnabled(true);
  snapshotRoster();

  return {
    setMuted: async (muted: boolean) => {
      await room.localParticipant.setMicrophoneEnabled(!muted);
      snapshotRoster();
    },
    disconnect: async () => {
      intentionalDisconnect = true;
      await room.disconnect();
    },
  };
}
