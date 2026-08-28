/**
 * 語音房狀態機（PR-03，LiveKit）。
 *
 * 兩層事實，各歸各位：
 *  - **LiveKit**：誰真的在線上講話（roster、speaking、muted）— 即時、
 *    連線期間有效。
 *  - **voice_sessions / voice_session_participants（0014）**：房裡有一場
 *    語音在進行的持久紀錄 — 沒加入的成員也看得到、離開有 left_at。
 *    RLS：session insert/update 要 can_manage_media（reviewer 不能開場，
 *    但能加入既有場）；participants 只能寫自己的列。
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
import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchVoiceToken, voiceHealth } from "../cloud/voiceToken";
import { connectVoice, type VoiceConnection, type VoiceParticipantInfo } from "../features/voice/liveVoice";

export type VoiceRoomState = "idle" | "connecting" | "live" | "error";

export type VoiceDockApi = {
  available: boolean;
  state: VoiceRoomState;
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

export function useVoiceRoom({ supabase, boundRoomId, userId, displayName, canManage }: Params): VoiceDockApi {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<VoiceRoomState>("idle");
  const [participants, setParticipants] = useState<VoiceParticipantInfo[]>([]);
  const [activeSessionTitle, setActiveSessionTitle] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectionRef = useRef<VoiceConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const roomRef = useRef<string | null>(boundRoomId);
  roomRef.current = boundRoomId;
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 世代序號：任何離場動作遞增，使 in-flight 的 join/refresh 作廢。 */
  const joinSeqRef = useRef(0);
  /** 同步重入鎖：state 是非同步 commit，擋不住連點（Grok 03 F4）。 */
  const joiningRef = useRef(false);

  useEffect(() => {
    if (!supabase || !boundRoomId) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    void voiceHealth(supabase).then((health) => {
      if (!cancelled) setAvailable(Boolean(health.ok));
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, boundRoomId]);

  // 進行中 session 的探測：只在自己不在 live 時跑（live 時 sessionIdRef
  // 由 join 擁有，不得被 probe 覆蓋 — Grok 03 F5）。「進行中」以有
  // 未離開的參與者為準，空場不顯示。
  useEffect(() => {
    if (!supabase || !boundRoomId || !available) {
      setActiveSessionTitle(null);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      if (stateRef.current === "live" || stateRef.current === "connecting") return;
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
    if (connection) await connection.disconnect().catch(() => undefined);
    const sessionId = sessionIdRef.current;
    if (markLeft && supabase && sessionId && userId && roomRef.current) {
      await supabase
        .from("voice_session_participants")
        .update({ left_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .then(() => undefined, () => undefined);
      // 最後一人離開：有權限就把場結掉（Grok 03 F5）。
      await endSessionIfEmpty(sessionId);
    }
    setParticipants([]);
    setMuted(false);
  }, [supabase, userId, endSessionIfEmpty]);

  const handleUnexpectedDisconnect = useCallback((seq: number) => {
    if (seq !== joinSeqRef.current) return; // 已離場的舊連線，不改 UI
    connectionRef.current = null;
    clearRefreshTimer();
    setState("error");
    setError("語音連線中斷了 — 按「加入語音」重新連上。");
    setParticipants([]);
  }, []);

  const scheduleTokenRefresh = useCallback((seq: number, roomId: string, ttlSeconds: number) => {
    const refreshMs = Math.max(60, ttlSeconds - 120) * 1000;
    clearRefreshTimer();
    refreshTimerRef.current = window.setTimeout(() => {
      void (async () => {
        if (!supabase || seq !== joinSeqRef.current) return;
        const fresh = await fetchVoiceToken(supabase, roomId, displayName);
        if (seq !== joinSeqRef.current || !connectionRef.current) return;
        if (!fresh.ok) {
          // 換發失敗：現連線會在 TTL 到期時斷 → handleUnexpectedDisconnect
          return;
        }
        const previous = connectionRef.current;
        connectionRef.current = null;
        await previous.disconnect().catch(() => undefined);
        if (seq !== joinSeqRef.current) return; // 換發窗內使用者離開了（Grok 03 F2）
        const reconnected = await connectVoice({
          url: fresh.url,
          token: fresh.token,
          onRoster: setParticipants,
          onDisconnected: () => handleUnexpectedDisconnect(seq),
        }).catch(() => null);
        if (seq !== joinSeqRef.current) {
          // 離場與重連 race：把剛建的連線收乾淨。
          if (reconnected) await reconnected.disconnect().catch(() => undefined);
          return;
        }
        if (reconnected) {
          connectionRef.current = reconnected;
          scheduleTokenRefresh(seq, roomId, ttlSeconds);
        } else {
          setState("error");
          setError("語音換發連線失敗 — 按「加入語音」重新連上。");
        }
      })();
    }, refreshMs);
  }, [supabase, displayName, handleUnexpectedDisconnect]);

  const join = useCallback(() => {
    const roomId = roomRef.current;
    if (!supabase || !roomId || !userId) return;
    if (joiningRef.current || stateRef.current === "live") return;
    joiningRef.current = true;
    const seq = ++joinSeqRef.current;
    setState("connecting");
    setError(null);
    void (async () => {
      let createdSessionId: string | null = null;
      try {
        // 1) 收斂到最舊的 live session；沒有就開一場（RLS：開場要 can_manage）
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
            setState("idle");
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
          // 兩人同時開場：再選一次最舊；自己的不是最舊就結束自己那場
          // 改加入較舊的（Grok 03 F5）。
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

        // 2) 自己的參與者列（重進覆蓋 left_at）
        await supabase.from("voice_session_participants").upsert({
          session_id: session.id,
          room_id: roomId,
          user_id: userId,
          display_name: displayName,
          muted: false,
          left_at: null,
        });
        if (seq !== joinSeqRef.current) return;

        // 3) token → LiveKit
        const tokenResult = await fetchVoiceToken(supabase, roomId, displayName);
        if (seq !== joinSeqRef.current) return;
        if (!tokenResult.ok) {
          setState("error");
          setError(
            tokenResult.code === "VOICE_NOT_CONFIGURED"
              ? "語音服務尚未設定。"
              : "語音連線暫時失敗，稍後再試一次。",
          );
          return;
        }
        const connection = await connectVoice({
          url: tokenResult.url,
          token: tokenResult.token,
          onRoster: setParticipants,
          onDisconnected: () => handleUnexpectedDisconnect(seq),
        });
        if (seq !== joinSeqRef.current) {
          // 連線期間使用者已離開/換房（Grok 03 F1）：收乾淨、不碰 UI。
          await connection.disconnect().catch(() => undefined);
          return;
        }
        connectionRef.current = connection;
        setState("live");
        scheduleTokenRefresh(seq, roomId, tokenResult.ttlSeconds);
      } catch (err) {
        // 參與者列先落了才連線失敗：補 left_at，別留「在場中」的殭屍列。
        if (supabase && sessionIdRef.current) {
          await supabase
            .from("voice_session_participants")
            .update({ left_at: new Date().toISOString() })
            .eq("session_id", sessionIdRef.current)
            .eq("user_id", userId)
            .then(() => undefined, () => undefined);
        }
        // 自己剛開的場連不上：立刻結掉，不留空場（Grok 03 F5）。
        if (createdSessionId && supabase) {
          await supabase
            .from("voice_sessions")
            .update({ status: "ended", ended_at: new Date().toISOString() })
            .eq("id", createdSessionId)
            .then(() => undefined, () => undefined);
        }
        if (seq === joinSeqRef.current) {
          setState("error");
          const message = err instanceof Error ? err.message : "";
          setError(
            /permission|NotAllowed/i.test(message)
              ? "麥克風權限被拒。請在瀏覽器網址列旁允許麥克風後再試。"
              : "語音加入失敗，稍後再試一次。",
          );
          setParticipants([]);
        }
      } finally {
        joiningRef.current = false;
      }
    })();
  }, [supabase, userId, displayName, canManage, scheduleTokenRefresh, handleUnexpectedDisconnect]);

  const leave = useCallback(() => {
    joinSeqRef.current += 1; // in-flight join / 換發全部作廢
    void teardown(true);
    setState("idle");
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

  // 換房/卸載：世代作廢＋離場。
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
    participants,
    activeSessionTitle,
    muted,
    error,
    canStart: canManage,
    join,
    leave,
    toggleMute,
  };
}
