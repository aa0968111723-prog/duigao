/**
 * LiveKit 連線的薄封裝（PR-03）。
 *
 * livekit-client 約 580KB min — 與 peerjs 同一套紀律：動態載入，
 * 只有真的按下「加入語音」的那一刻才付這筆；Home 首屏與純文字討論
 * 完全不揹。載入失敗（離線）走誠實錯誤，不白屏。
 *
 * 這一層做四件事：connect（含開麥）、**遠端音軌 attach（沒有這步就
 * 聽不到聲音 — Grok 03 F3）**、mute、disconnect；並把參與者事件折成
 * 一個 roster 回呼。誰在房裡、誰在講話，以 LiveKit 的即時事實為準；
 * voice_session_participants 的 DB 列由 useVoiceRoom 維護。
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
    adaptiveStream: false,
    dynacast: false,
  });

  let intentionalDisconnect = false;
  // 遠端音軌的 <audio> 元素（Grok 03 F3）：attach 才有聲音。統一收在
  // 這個集合，斷線時全部 detach＋移出 DOM，不留殭屍元素。
  const attachedAudio = new Set<HTMLMediaElement>();

  const attachAudioTrack = (track: { kind: string; attach: () => HTMLMediaElement }) => {
    if (track.kind !== "audio") return;
    const element = track.attach();
    element.style.display = "none";
    document.body.appendChild(element);
    attachedAudio.add(element);
  };
  const detachAudioTrack = (track: { kind: string; detach: () => HTMLMediaElement[] }) => {
    if (track.kind !== "audio") return;
    for (const element of track.detach()) {
      attachedAudio.delete(element);
      element.remove();
    }
  };
  const detachAll = () => {
    for (const element of attachedAudio) element.remove();
    attachedAudio.clear();
  };

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

  room.on(RoomEvent.TrackSubscribed, (track) => {
    attachAudioTrack(track as never);
    snapshotRoster();
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    detachAudioTrack(track as never);
    snapshotRoster();
  });

  const rosterOnlyEvents = [
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.ActiveSpeakersChanged,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
  ] as const;
  for (const event of rosterOnlyEvents) {
    room.on(event, snapshotRoster);
  }

  room.on(RoomEvent.Disconnected, (reason) => {
    detachAll();
    if (!intentionalDisconnect) input.onDisconnected(String(reason ?? "disconnected"));
  });

  await room.connect(input.url, input.token);
  try {
    // 開麥失敗（權限拒絕）＝沒有加入：把剛建立的連線收乾淨再上拋
    //（Grok 03 F1 — 不留「連著但 UI 說失敗」的幽靈）。
    await room.localParticipant.setMicrophoneEnabled(true);
  } catch (err) {
    intentionalDisconnect = true;
    await room.disconnect().catch(() => undefined);
    room.removeAllListeners();
    detachAll();
    throw err;
  }
  snapshotRoster();

  return {
    setMuted: async (muted: boolean) => {
      await room.localParticipant.setMicrophoneEnabled(!muted);
      snapshotRoster();
    },
    disconnect: async () => {
      intentionalDisconnect = true;
      await room.disconnect().catch(() => undefined);
      // 舊 Room 的 listener 不得再打 roster 回呼（Grok 03 F2）。
      room.removeAllListeners();
      detachAll();
    },
  };
}
