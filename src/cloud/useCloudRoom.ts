import { useCallback, useEffect, useRef, useState } from "react";
import type { Guest, Room, Version } from "../lib/types";
import { saveRoom } from "../lib/store";
import type { ShowToast } from "../toast";
import {
  applyCloudProposals,
  getProposalDocs,
  setProposalCloudSync,
  type ProposalBackground,
  type ProposalItem,
  type VisualProposal,
} from "../features/visual-proposal/store";
import { isCloudConfigured } from "./config";
import { getSupabase } from "./client";
import { ensureSession } from "./auth";
import { isDuplicateKey, isInvalidInvite, isRevisionConflict } from "./errors";
import { buildInviteUrl, generateInviteToken, readInviteFromUrl } from "./invite";
import { getCloudMapping, saveCloudMapping } from "./mapping";
import {
  addVersion as repoAddVersion,
  createRoom,
  deleteStroke as repoDeleteStroke,
  insertComment,
  insertMessage,
  insertReply as repoInsertReply,
  insertStroke,
  joinRoom,
  loadRoom,
  setCommentResolved,
  setPreference,
  setRoomTitle,
  setSupport,
  upsertProposal,
  type CloudProposal,
} from "./roomRepository";
import { subscribeRoom, type Unsubscribe } from "./roomSync";
import type { SyncStatus } from "./types";

const DEFAULT_BG: ProposalBackground = {
  color: "#000000",
  colorOpacity: 0,
  gradient: "none",
  gradientFrom: "#000000",
  gradientTo: "#c45c4a",
  gradientOpacity: 0,
  imageOpacity: 1,
  imageFit: "cover",
};

export type CloudWrites = {
  setTitle: (title: string) => void;
  insertComment: (pin: import("../lib/types").CommentPin) => void;
  setResolved: (id: string, resolved: boolean) => void;
  insertStroke: (stroke: import("../lib/types").Stroke) => void;
  deleteStroke: (id: string) => void;
  insertMessage: (msg: import("../lib/types").ChatMessage) => void;
  addVersion: (label: string, sortOrder: number, imageDataUrl: string) => void;
  toggleSupport: (commentId: string, add: boolean) => void;
  insertReply: (reply: import("../lib/types").CommentReply) => void;
  setProposalPref: (versionId: string, choice: string) => void;
};

type Params = {
  guest: Guest | null;
  room: Room | null;
  isGuestSession: boolean;
  onSnapshot: (room: Room) => void;
  showToast: ShowToast;
};

function proposalToStore(p: CloudProposal): VisualProposal {
  const payload = p.payload as { items?: ProposalItem[]; background?: ProposalBackground };
  return {
    id: p.id,
    versionId: p.versionId,
    name: p.name,
    authorName: p.authorName,
    items: Array.isArray(payload.items) ? payload.items : [],
    background: payload.background ?? DEFAULT_BG,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Binds the active room to the cloud when configured. Inert (returns
 * local-only) otherwise, so the local IndexedDB + PeerJS path is untouched.
 */
export function useCloudRoom({ guest, room, isGuestSession, onSnapshot, showToast }: Params) {
  const [status, setStatus] = useState<SyncStatus>(isCloudConfigured ? "connecting" : "local-only");
  const [online, setOnline] = useState(0);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteInvalid, setInviteInvalid] = useState(false);
  const [bindNonce, setBindNonce] = useState(0);

  const boundRef = useRef<string | null>(null); // cloud room id
  const unsubRef = useRef<Unsubscribe | null>(null);
  const revisions = useRef<Map<string, number>>(new Map());
  const pending = useRef<Array<() => Promise<void>>>([]);
  const reloadTimer = useRef<number | null>(null);
  const supabase = getSupabase();

  const reload = useCallback(async () => {
    const rid = boundRef.current;
    if (!supabase || !rid) return;
    setStatus("syncing");
    try {
      const snap = await loadRoom(supabase, rid);
      onSnapshot(snap.room);
      saveRoom(snap.room).catch(() => undefined);
      revisions.current = new Map(snap.proposals.map((p) => [p.id, p.revision]));
      applyCloudProposals(rid, snap.proposals.map(proposalToStore));
      setStatus("synced");
    } catch {
      setStatus("error");
    }
  }, [supabase, onSnapshot]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => void reload(), 200);
  }, [reload]);

  const flushPending = useCallback(async () => {
    if (!pending.current.length) return;
    const queue = pending.current;
    pending.current = [];
    for (const task of queue) {
      try {
        await task();
      } catch (err) {
        // The write already landed on a previous attempt: done, not an error.
        if (!isDuplicateKey(err)) pending.current.push(task);
      }
    }
    setStatus(pending.current.length ? "offline-pending" : "synced");
  }, []);

  /** Run a cloud write with optimistic UI already done; queue + degrade on failure. */
  const run = useCallback(
    (task: () => Promise<void>) => {
      if (!supabase || !boundRef.current) return;
      setStatus("syncing");
      task()
        .then(() => setStatus(pending.current.length ? "offline-pending" : "synced"))
        .catch((err) => {
          if (isDuplicateKey(err)) {
            setStatus(pending.current.length ? "offline-pending" : "synced");
            return;
          }
          pending.current.push(task);
          setStatus("offline-pending");
        });
    },
    [supabase],
  );

  // Bind: join (guest with invite) or reconnect (owner via mapping), then load + subscribe.
  useEffect(() => {
    if (!supabase || !guest) return;
    const url = readInviteFromUrl();
    const mapping = room ? getCloudMapping(room.id) : null;

    let targetRoomId: string | null = null;
    let token: string | null = null;
    if (isGuestSession && url) {
      targetRoomId = url.roomId;
      token = url.invite;
    } else if (mapping) {
      targetRoomId = mapping.roomId;
      token = mapping.token;
    }
    if (!targetRoomId) {
      setStatus("local-only");
      return;
    }
    if (boundRef.current === targetRoomId) return;

    let cancelled = false;
    setStatus("connecting");
    setInviteInvalid(false);
    (async () => {
      try {
        await ensureSession(supabase);
        if (isGuestSession && token) {
          await joinRoom(supabase, targetRoomId, token, guest);
        }
        if (cancelled) return;
        boundRef.current = targetRoomId;
        setInviteUrl(token ? buildInviteUrl(targetRoomId, token) : null);
        await reload();
        setProposalCloudSync(targetRoomId, (doc) => {
          run(async () => {
            const expected = revisions.current.get(doc.id) ?? 0;
            try {
              const next = await upsertProposal(supabase, targetRoomId!, {
                id: doc.id,
                versionId: doc.versionId,
                authorName: doc.authorName,
                name: doc.name,
                payload: { items: doc.items, background: doc.background },
                revision: expected,
              });
              revisions.current.set(doc.id, next);
            } catch (err) {
              if (isRevisionConflict(err)) {
                showToast("提案剛被其他夥伴更新，已載入最新內容");
                await reload();
              } else {
                throw err;
              }
            }
          });
        });
        unsubRef.current = subscribeRoom(supabase, targetRoomId, (await supabase.auth.getUser()).data.user?.id ?? "anon", {
          onRoom: scheduleReload,
          onCommentUpsert: scheduleReload,
          onStrokeInsert: scheduleReload,
          onStrokeDelete: scheduleReload,
          onMessageInsert: scheduleReload,
          onVersionInsert: scheduleReload,
          onProposalUpsert: (r) => {
            revisions.current.set(r.id, r.revision);
            applyCloudProposals(targetRoomId!, [
              proposalToStore({ id: r.id, versionId: r.version_id, authorName: r.author_name, name: r.name, payload: r.payload, revision: r.revision }),
            ]);
          },
          onFeedbackChange: scheduleReload,
          onPresence: setOnline,
          onStatus: (connected) => {
            if (connected) void flushPending();
            setStatus((s) => (connected ? (pending.current.length ? "offline-pending" : "synced") : "connecting"));
          },
        });
      } catch (err) {
        if (cancelled) return;
        if (isInvalidInvite(err)) {
          setInviteInvalid(true);
          showToast("這個分享連結已失效，請向主辦方取得新連結", { tone: "error" });
        }
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      if (boundRef.current) setProposalCloudSync(boundRef.current, null);
      unsubRef.current?.();
      unsubRef.current = null;
      boundRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, guest?.id, isGuestSession, room?.id, bindNonce]);

  /**
   * Self-heal after phone freezes / network loss: whenever the tab is visible
   * or online again, push queued writes out and pull the latest snapshot, so
   * coming back from LINE never leaves the room stale or stuck.
   */
  useEffect(() => {
    const revive = () => {
      void flushPending();
      if (boundRef.current) void reload();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") revive();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", revive);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", revive);
    };
  }, [flushPending, reload]);

  /** 再試一次: reload when bound, otherwise redo auth + join + load from scratch. */
  const retry = useCallback(() => {
    setInviteInvalid(false);
    if (boundRef.current) {
      void flushPending();
      void reload();
    } else {
      setStatus("connecting");
      setBindNonce((n) => n + 1);
    }
  }, [flushPending, reload]);

  const ensureShared = useCallback(async (): Promise<string | null> => {
    if (!supabase || !guest || !room) return null;
    if (boundRef.current) {
      const mapping = getCloudMapping(room.id);
      const token = mapping?.token;
      const url = token ? buildInviteUrl(boundRef.current, token) : inviteUrl;
      return url;
    }
    setStatus("syncing");
    try {
      await ensureSession(supabase);
      const token = generateInviteToken();
      // Gather the room's proposals from the store cache so they migrate too.
      const localProposals: CloudProposal[] = getProposalDocs(room.id).map((d) => ({
        id: d.id,
        versionId: d.versionId,
        authorName: d.authorName,
        name: d.name,
        payload: { items: d.items, background: d.background },
        revision: 1,
      }));
      const { roomId } = await createRoom(supabase, { room, proposals: localProposals }, guest, token);
      saveCloudMapping(room.id, { roomId, token });
      boundRef.current = roomId;
      const url = buildInviteUrl(roomId, token);
      setInviteUrl(url);
      await reload();
      setProposalCloudSync(roomId, (doc) => {
        run(async () => {
          const expected = revisions.current.get(doc.id) ?? 0;
          const next = await upsertProposal(supabase, roomId, {
            id: doc.id,
            versionId: doc.versionId,
            authorName: doc.authorName,
            name: doc.name,
            payload: { items: doc.items, background: doc.background },
            revision: expected,
          });
          revisions.current.set(doc.id, next);
        });
      });
      setStatus("synced");
      return url;
    } catch {
      setStatus("error");
      showToast("建立分享連結失敗，內容仍保存在這台裝置。", { tone: "error" });
      return null;
    }
  }, [supabase, guest, room, inviteUrl, reload, run, showToast]);

  const writes: CloudWrites = {
    setTitle: (title) => run(() => setRoomTitle(supabase!, boundRef.current!, title)),
    insertComment: (pin) => run(() => insertComment(supabase!, boundRef.current!, pin)),
    setResolved: (id, resolved) => run(() => setCommentResolved(supabase!, id, resolved)),
    insertStroke: (stroke) => run(() => insertStroke(supabase!, boundRef.current!, stroke)),
    deleteStroke: (id) => run(() => repoDeleteStroke(supabase!, id)),
    insertMessage: (msg) => run(() => insertMessage(supabase!, boundRef.current!, msg)),
    addVersion: (label, sortOrder, imageDataUrl) =>
      run(async () => {
        const v: Version = await repoAddVersion(supabase!, boundRef.current!, label, sortOrder, imageDataUrl);
        void v;
        scheduleReload();
      }),
    toggleSupport: (commentId, add) => run(() => setSupport(supabase!, boundRef.current!, commentId, add)),
    insertReply: (reply) => run(() => repoInsertReply(supabase!, boundRef.current!, reply)),
    setProposalPref: (versionId, choice) => run(() => setPreference(supabase!, boundRef.current!, versionId, choice)),
  };

  return {
    status,
    online,
    inviteUrl,
    inviteInvalid,
    boundRoomId: boundRef.current,
    active: Boolean(supabase),
    ensureShared,
    retry,
    writes,
  };
}
