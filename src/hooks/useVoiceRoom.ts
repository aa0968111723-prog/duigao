/**
 * 語音房狀態機（PR-03，LiveKit；PR-GAP-03 誠實九態）。
 *
 * 兩層事實，各歸各位：
 *  - **LiveKit**：誰真的在線上講話（roster、speaking、muted）— 即時、
 *    連線期間有效。只在 phase === connected 時對外顯示。
 *  - **voice_sessions / voice_session_participants（0014）**：房裡有一場
 *    語音在進行的持久紀錄 — 沒加入的成員也看得到、離開有 left_at。
 *    RLS：session insert/update 要 can_manage_media（reviewer 不能開場，
 *    但能加入既有場）；participants 只能寫自己的列。
 *
 * 對 RoomDiscussion（#95 擁有）只多暴露 `phase`；`state` 由
 * voicePhaseToDockState 派生，live / connecting / error 契約不變。
 *
 * 併發紀律（Grok 03 F1/F2/F4）：
 *  - joinSeq 世代序號：leave／換房／unmount／新 join 都遞增；任何
 *    async 續段發現世代過期就把自己建立的連線收乾淨後退場 — 不存在
 *    「UI 已離開但麥克風還活著」的狀態。
 *  - joiningRef 同步鎖：連點不會並行兩條 join。
 *
 * session 生命週期（Grok 03 F5）：
 *  - join 一律收斂到「最舊的 live session」；自己剛建的若不是最舊，
 *    立刻結束自己那場改加入較舊的 — 兩人同時開場最終只剩一場。
 *  - 連線失敗時自己剛建的場立刻標 ended，不留空場。
 *  - 「語音進行中」的顯示以「有 left_at IS NULL 的參與者」為準 —
 *    空場（都離開了）不再顯示進行中。
 *  - 最後一人離開且有權限時順手把 session 標 ended（無權限則靠
 *    顯示規則兜底 — 誠實優先於一致）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchVoiceToken, voiceHealth } from "../cloud/voiceToken";
import { connectVoice, type VoiceConnection, type VoiceParticipantInfo } from "../features/voice/liveVoice";
import {
  canShowVoiceParticipants,
  classifyConnectFailure,
  parseVoiceHealthPayload,
  parseVoiceTokenPayload,
  type VoiceTruthfulPhase,
  voicePhaseMessage,
  voicePhaseToDockState,
} from "../features/voice/voiceState";

export type VoiceRoomState = "idle" | "connecting" | "live" | "error";

export type VoiceDockApi = {
  available: boolean;
  state: VoiceRoomState;
  phase: VoiceTruthfulPhase;
  participants: VoiceParticipantInfo[];
  /** 房裡是否已有進行中的 session（未加入也看得到）。 */
  activeSessionTitle: string | null;
  muted: boolean;
  error: string | null;
  canStart: boolean;
  join: () => void;
  leave: () => void;
  toggleMute: () => void;
};

type Params = {
  supabase: SupabaseClient | null;
  boundRoomId: string | null;
  userId: string | null;
  displayName: string;
  canManage: boolean;
};

const ACTIVE_JOIN_PHASES: ReadonlySet<VoiceTruthfulPhase> = new Set([
  "joining",
  "requesting-permission",
  "connected",
  "reconnecting",
]);

export function useVoiceRoom({ supabase, boundRoomId, userId, displayName, canManage }: Params): VoiceDockApi {
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<VoiceTruthfulPhase>("idle");
  const [participants, setParticipants] = useState<VoiceParticipantInfo[]>([]);
  const [activeSessionTitle, setActiveSessionTitle] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectionRef = useRef<VoiceConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const rosterRef = useRef<VoiceParticipantInfo[]>([]);
  const refreshTimerRef = useRef<number | null>(null);
  const roomRef = useRef<string | null>(boundRoomId);
  roomRef.current = boundRoomId;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** 世代序號：任何離場動作遞增，使 in-flight 的 join/refresh 作廢。 */
  const joinSeqRef = useRef(0);
  /** 同步重入鎖：state 是非同步 commit，擋不住連點（Grok 03 F4）。 */
  const joiningRef = useRef(false);

  const state = useMemo(() => voicePhaseToDockState(phase), [phase]);

  useEffect(() => {
    if (!supabase || !boundRoomId) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    void voiceHealth(supabase).then((health) => {
      if (cancelled) return;
      if (ACTIVE_JOIN_PHASES.has(phaseRef.current)) return;
      const parsed = parseVoiceHealthPayload(health);
      setAvailable(parsed.ok);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, boundRoomId]);

  // 進行中 session 的探測：只在自己不在加入／連線中時跑（live 時
  // sessionIdRef 由 join 擁有，不得被 probe 覆蓋 — Grok 03 F5）。
  useEffect(() => {
    if (!supabase || !boundRoomId || !available) {
      setActiveSessionTitle(null);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      if (ACTIVE_JOIN_PHASES.has(phaseRef.current)) return;
      const { data: sessions } = await supabase
        .from("voice_sessions")
        .select("id,title,status")
        .eq("room_id", boundRoomId)
        .eq("status", "live")
        .order("created_at", { ascending: true });
      if (cancelled) return;
      const rows = Array.isArray(sessions) ? sessions : [];
      if (!rows.length) {
        setActiveSessionTitle(null);
        return;
      }
      const ids = rows.map((row) => String(row.id));
      const { data: active } = await supabase
        .from("voice_session_participants")
        .select("session_id")
        .in("session_id", ids)
        .is("left_at", null)
        .limit(1);
      if (cancelled) return;
      const liveWithPeople = Array.isArray(active) && active.length > 0;
      setActiveSessionTitle(liveWithPeople ? String(rows[0].title ?? "語音房間") : null);
    };
    void probe();
    const timer = window.setInterval(probe, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [supabase, boundRoomId, available]);

  const clearRefreshTimer = () => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  };

  const endSessionIfEmpty = useCallback(async (sessionId: string) => {
    if (!supabase) return;
    const { data: remaining } = await supabase
      .from("voice_session_participants")
      .select("user_id")
      .eq("session_id", sessionId)
      .is("left_at", null)
      .limit(1);
    if (Array.isArray(remaining) && remaining.length === 0 && canManage) {
      await supabase
        .from("voice_sessions")
        .update({ status: "ended", ended_at: new Date().toISOString() })
        .eq("id", sessionId)
        .then(() => undefined, () => undefined);
    }
  }, [supabase, canManage]);

  const teardown = useCallback(async (markLeft: boolean) => {
    clearRefreshTimer();
    const connection = connectionRef.current;
    connectionRef.current = null;
    if (connection) {
      await connection.setMuted(true).catch(() => undefined);
      await connection.disconnect().catch(() => undefined);
    }
    const sessionId = sessionIdRef.current;
    if (markLeft && supabase && sessionId && userId && roomRef.current) {
      await supabase
        .from("voice_session_participants")
        .update({ left_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .then(() => undefined, () => undefined);
      await endSessionIfEmpty(sessionId);
    }
    rosterRef.current = [];
    setParticipants([]);
    setMuted(false);
  }, [supabase, userId, endSessionIfEmpty]);

  const abandonFailedJoin = useCallback(async (createdSessionId: string | null) => {
    const sessionId = sessionIdRef.current;
    if (supabase && sessionId && userId) {
      await supabase
        .from("voice_session_participants")
        .update({ left_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .then(() => undefined, () => undefined);
    }
    if (createdSessionId && supabase) {
      await supabase
        .from("voice_sessions")
        .update({ status: "ended", ended_at: new Date().toISOString() })
        .eq("id", createdSessionId)
        .then(() => undefined, () => undefined);
    }
    if (sessionId) await endSessionIfEmpty(sessionId);
    rosterRef.current = [];
    setParticipants([]);
  }, [supabase, userId, endSessionIfEmpty]);

  const handleUnexpectedDisconnect = useCallback((seq: number) => {
    if (seq !== joinSeqRef.current) return;
    connectionRef.current = null;
    clearRefreshTimer();
    void (async () => {
      await abandonFailedJoin(null);
      if (seq !== joinSeqRef.current) return;
      phaseRef.current = "connection-failed";
      setPhase("connection-failed");
      setError(voicePhaseMessage("connection-failed"));
    })();
  }, [abandonFailedJoin]);

  const applyTokenFailure = (raw: unknown) => {
    const parsed = parseVoiceTokenPayload(raw);
    if (parsed.ok) return false;
    phaseRef.current = parsed.phase;
    setPhase(parsed.phase);
    setError(voicePhaseMessage(parsed.phase));
    rosterRef.current = [];
    setParticipants([]);
    return true;
  };

  const publishRoster = (list: VoiceParticipantInfo[]) => {
    rosterRef.current = list;
    if (phaseRef.current === "connected") setParticipants(list);
  };

  const markConnected = (list?: VoiceParticipantInfo[]) => {
    if (list) rosterRef.current = list;
    phaseRef.current = "connected";
    setPhase("connected");
    setError(null);
    setParticipants(rosterRef.current);
  };

  const scheduleTokenRefresh = useCallback((seq: number, roomId: string, ttlSeconds: number) => {
    const refreshMs = Math.max(60, ttlSeconds - 120) * 1000;
    clearRefreshTimer();
    refreshTimerRef.current = window.setTimeout(() => {
      void (async () => {
        if (!supabase || seq !== joinSeqRef.current) return;
        // RoomDiscussion only shows Leave when dock state is live.
        // Release mic/session first so reconnecting (connecting) never
        // hides leave while the previous LiveKit session is still open.
        const previous = connectionRef.current;
        connectionRef.current = null;
        await previous?.setMuted(true).catch(() => undefined);
        await previous?.disconnect().catch(() => undefined);
        if (seq !== joinSeqRef.current) return;
        phaseRef.current = "reconnecting";
        setPhase("reconnecting");
        setParticipants([]);
        const fresh = await fetchVoiceToken(supabase, roomId, displayName);
        if (seq !== joinSeqRef.current) return;
        if (!fresh.ok) {
          applyTokenFailure(fresh);
          await teardown(true);
          return;
        }
        const parsed = parseVoiceTokenPayload(fresh);
        if (!parsed.ok) {
          applyTokenFailure(parsed);
          await teardown(true);
          return;
        }
        if (seq !== joinSeqRef.current) return;
        const reconnected = await connectVoice({
          url: parsed.url,
          token: parsed.token,
          onRoster: publishRoster,
          onDisconnected: () => handleUnexpectedDisconnect(seq),
        }).catch((err) => {
          if (seq === joinSeqRef.current) {
            const failed = classifyConnectFailure(err);
            phaseRef.current = failed;
            setPhase(failed);
            setError(voicePhaseMessage(failed));
            rosterRef.current = [];
            setParticipants([]);
          }
          return null;
        });
        if (seq !== joinSeqRef.current) {
          if (reconnected) await reconnected.disconnect().catch(() => undefined);
          return;
        }
        if (reconnected) {
          connectionRef.current = reconnected;
          markConnected();
          scheduleTokenRefresh(seq, roomId, parsed.ttlSeconds);
        } else if (phaseRef.current === "reconnecting") {
          phaseRef.current = "connection-failed";
          setPhase("connection-failed");
          setError(voicePhaseMessage("connection-failed"));
        }
      })();
    }, refreshMs);
  }, [supabase, displayName, handleUnexpectedDisconnect, teardown]);

  const join = useCallback(() => {
    const roomId = roomRef.current;
    if (!supabase || !roomId || !userId) return;
    if (joiningRef.current || phaseRef.current === "connected") return;
    joiningRef.current = true;
    const seq = ++joinSeqRef.current;
    phaseRef.current = "joining";
    setPhase("joining");
    setError(null);
    rosterRef.current = [];
    setParticipants([]);
    void (async () => {
      let createdSessionId: string | null = null;
      try {
        const pickOldestLive = async (): Promise<{ id: string } | null> => {
          const { data } = await supabase
            .from("voice_sessions")
            .select("id")
            .eq("room_id", roomId)
            .eq("status", "live")
            .order("created_at", { ascending: true })
            .limit(1);
          return Array.isArray(data) && data[0] ? { id: String(data[0].id) } : null;
        };
        let session = await pickOldestLive();
        if (seq !== joinSeqRef.current) return;
        if (!session) {
          if (!canManage) {
            phaseRef.current = "idle";
            setPhase("idle");
            setError("還沒有人開語音。請房主或協作者先開始。");
            return;
          }
          const { data: created, error: createError } = await supabase
            .from("voice_sessions")
            .insert({ room_id: roomId, title: "語音房間", status: "live" })
            .select("id")
            .single();
          if (createError || !created) throw new Error("session-create-failed");
          createdSessionId = String(created.id);
          session = (await pickOldestLive()) ?? { id: createdSessionId };
          if (session.id !== createdSessionId) {
            await supabase
              .from("voice_sessions")
              .update({ status: "ended", ended_at: new Date().toISOString() })
              .eq("id", createdSessionId)
              .then(() => undefined, () => undefined);
            createdSessionId = null;
          }
        }
        if (seq !== joinSeqRef.current) return;
        sessionIdRef.current = session.id;

        await supabase.from("voice_session_participants").upsert({
          session_id: session.id,
          room_id: roomId,
          user_id: userId,
          display_name: displayName,
          muted: false,
          left_at: null,
        });
        if (seq !== joinSeqRef.current) return;

        const tokenResult = await fetchVoiceToken(supabase, roomId, displayName);
        if (seq !== joinSeqRef.current) return;
        const parsed = parseVoiceTokenPayload(tokenResult);
        if (!parsed.ok) {
          await abandonFailedJoin(createdSessionId);
          if (seq !== joinSeqRef.current) return;
          phaseRef.current = parsed.phase;
          setPhase(parsed.phase);
          setError(voicePhaseMessage(parsed.phase));
          return;
        }

        phaseRef.current = "requesting-permission";
        setPhase("requesting-permission");
        const connection = await connectVoice({
          url: parsed.url,
          token: parsed.token,
          onRoster: publishRoster,
          onDisconnected: () => handleUnexpectedDisconnect(seq),
        });
        if (seq !== joinSeqRef.current) {
          await connection.disconnect().catch(() => undefined);
          return;
        }
        connectionRef.current = connection;
        markConnected();
        scheduleTokenRefresh(seq, roomId, parsed.ttlSeconds);
      } catch (err) {
        await abandonFailedJoin(createdSessionId);
        if (seq === joinSeqRef.current) {
          const failed = classifyConnectFailure(err);
          phaseRef.current = failed;
          setPhase(failed);
          setError(voicePhaseMessage(failed));
        }
      } finally {
        joiningRef.current = false;
      }
    })();
  }, [supabase, userId, displayName, canManage, scheduleTokenRefresh, handleUnexpectedDisconnect, abandonFailedJoin]);

  const leave = useCallback(() => {
    joinSeqRef.current += 1;
    void teardown(true);
    phaseRef.current = "left";
    setPhase("left");
    setError(null);
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const connection = connectionRef.current;
    if (!connection) return;
    const next = !muted;
    setMuted(next);
    void connection.setMuted(next).catch(() => setMuted(!next));
    const sessionId = sessionIdRef.current;
    if (supabase && sessionId && userId) {
      void supabase
        .from("voice_session_participants")
        .update({ muted: next })
        .eq("session_id", sessionId)
        .eq("user_id", userId);
    }
  }, [muted, supabase, userId]);

  useEffect(() => {
    return () => {
      joinSeqRef.current += 1;
      void teardown(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundRoomId]);

  return {
    available,
    state,
    phase,
    participants: canShowVoiceParticipants(phase) ? participants : [],
    activeSessionTitle,
    muted,
    error,
    canStart: canManage,
    join,
    leave,
    toggleMute,
  };
}
