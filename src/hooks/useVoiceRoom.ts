/**
 * 語音房狀態機（PR-03，LiveKit）。
 *
 * 兩層事實，各歸各位：
 *  - **LiveKit**：誰真的在線上講話（roster、speaking、muted）— 即時、
 *    連線期間有效。
 *  - **voice_sessions / voice_session_participants（0014）**：房裡有一場
 *    語音在進行的持久紀錄 — 沒加入的成員也看得到、離開有 left_at。
 *    RLS：session insert 要 can_manage_media（reviewer 不能開場，但能加入
 *    既有場）；participants 只能寫自己的列。
 *
 * 誠實原則：
 *  - env 未設定（health 失敗）→ available=false，UI 維持既有的
 *    「語音房間還在準備」文案 — 入口不出現，不是灰按鈕。
 *  - 麥克風權限被拒 → error 態＋可照做的文案，不假裝已加入。
 *  - token TTL 10 分鐘 → 8 分鐘時預先換新（重連即換），到期斷線走
 *    onDisconnected 的誠實重連提示。
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
  /** cloud room id；未綁定（本機房）→ 語音不可用（語音必然是雲端功能）。 */
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

  // 可用性 gate：bound 的雲端房才問 health（快取在 voiceToken.ts）。
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

  // 進行中 session 的探測：讓沒加入的人看得到「語音進行中」。
  // 輕量輪詢換頁即止（realtime 訂閱屬後續 PR；表已在 publication）。
  useEffect(() => {
    if (!supabase || !boundRoomId || !available) {
      setActiveSessionTitle(null);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      const { data } = await supabase
        .from("voice_sessions")
        .select("id,title,status")
        .eq("room_id", boundRoomId)
        .eq("status", "live")
        .order("created_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      const row = Array.isArray(data) && data[0] ? data[0] : null;
      setActiveSessionTitle(row ? String(row.title ?? "語音房間") : null);
      if (row) sessionIdRef.current = String(row.id);
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

  const teardown = useCallback(async (markLeft: boolean) => {
    clearRefreshTimer();
    const connection = connectionRef.current;
    connectionRef.current = null;
    if (connection) await connection.disconnect().catch(() => undefined);
    const sessionId = sessionIdRef.current;
    if (markLeft && supabase && sessionId && userId && roomRef.current) {
      // 離開的持久紀錄：只寫自己的列（RLS 同語意）。失敗不擋 UI —
      // left_at 缺席的列由下次 join 的 upsert 覆蓋。
      await supabase
        .from("voice_session_participants")
        .update({ left_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .then(() => undefined, () => undefined);
    }
    setParticipants([]);
    setMuted(false);
  }, [supabase, userId]);

  const join = useCallback(() => {
    const roomId = roomRef.current;
    if (!supabase || !roomId || !userId || state === "connecting" || state === "live") return;
    setState("connecting");
    setError(null);
    void (async () => {
      try {
        // 1) session：找進行中的；沒有就開一場（RLS：開場要 can_manage_media）
        const { data: liveRows } = await supabase
          .from("voice_sessions")
          .select("id,title")
          .eq("room_id", roomId)
          .eq("status", "live")
          .order("created_at", { ascending: false })
          .limit(1);
        let sessionId = Array.isArray(liveRows) && liveRows[0] ? String(liveRows[0].id) : null;
        if (!sessionId) {
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
          sessionId = String(created.id);
        }
        sessionIdRef.current = sessionId;

        // 2) 參與者列（自己的；重進覆蓋 left_at）
        await supabase.from("voice_session_participants").upsert({
          session_id: sessionId,
          room_id: roomId,
          user_id: userId,
          display_name: displayName,
          muted: false,
          left_at: null,
        });

        // 3) token → LiveKit
        const tokenResult = await fetchVoiceToken(supabase, roomId, displayName);
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
          onDisconnected: () => {
            // 非主動離開（token 到期／網路）：誠實回到可重連狀態。
            connectionRef.current = null;
            clearRefreshTimer();
            setState("error");
            setError("語音連線中斷了 — 按「加入語音」重新連上。");
            setParticipants([]);
          },
        });
        connectionRef.current = connection;
        setState("live");

        // 4) TTL 換新：8 分鐘時以重連方式換 token（LiveKit 連線態的
        //    token 更新屬後續優化；先保證不會無預警到期斷線）。
        const refreshMs = Math.max(60, (tokenResult.ttlSeconds - 120)) * 1000;
        clearRefreshTimer();
        refreshTimerRef.current = window.setTimeout(() => {
          void (async () => {
            const fresh = await fetchVoiceToken(supabase, roomId, displayName);
            if (!fresh.ok || !connectionRef.current) return;
            // 簡單而誠實的策略：重連換 token（幾百毫秒的無聲窗）。
            const previous = connectionRef.current;
            connectionRef.current = null;
            await previous.disconnect().catch(() => undefined);
            const reconnected = await connectVoice({
              url: fresh.url,
              token: fresh.token,
              onRoster: setParticipants,
              onDisconnected: () => {
                connectionRef.current = null;
                clearRefreshTimer();
                setState("error");
                setError("語音連線中斷了 — 按「加入語音」重新連上。");
                setParticipants([]);
              },
            }).catch(() => null);
            if (reconnected) connectionRef.current = reconnected;
            else {
              setState("error");
              setError("語音換發連線失敗 — 按「加入語音」重新連上。");
            }
          })();
        }, refreshMs);
      } catch (err) {
        await teardown(false);
        setState("error");
        const message = err instanceof Error ? err.message : "";
        setError(
          /permission|NotAllowed/i.test(message)
            ? "麥克風權限被拒。請在瀏覽器網址列旁允許麥克風後再試。"
            : "語音加入失敗，稍後再試一次。",
        );
      }
    })();
  }, [supabase, userId, displayName, canManage, state, teardown]);

  const leave = useCallback(() => {
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
    // DB 的 muted 是持久展示值，失敗不擋 UI。
    const sessionId = sessionIdRef.current;
    if (supabase && sessionId && userId) {
      void supabase
        .from("voice_session_participants")
        .update({ muted: next })
        .eq("session_id", sessionId)
        .eq("user_id", userId);
    }
  }, [muted, supabase, userId]);

  // 換房/卸載：離開連線（不寫 left_at 的情況只有 unmount race；寫入失敗
  // 由下次 join 覆蓋）。
  useEffect(() => {
    return () => {
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
