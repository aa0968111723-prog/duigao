import { useEffect, useRef, useState } from "react";
import { loadDiscussionDraft, saveDiscussionDraft } from "../lib/store";

/**
 * IndexedDB hydrate must not wipe text the person already typed.
 * review-viewer 送出 stays disabled when an empty cache read lands after fill.
 */
export function acceptHydratedDraft(input: {
  incoming: string;
  current: string;
  userEdited: boolean;
}): string {
  if (input.userEdited) return input.current;
  return input.incoming;
}

/**
 * 討論輸入列草稿。IndexedDB 只是這台裝置的 cache：換房讀自己的稿，
 * 本機 id 綁成雲端 uuid 時把同一份稿遷過去。
 */
export function useDiscussionDraft(
  roomKey: string | null,
  migrateFrom?: string | null,
): [string, (value: string) => void, boolean] {
  const [draft, setDraft] = useState("");
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const dirtyRef = useRef(false);

  const setDraftFromUser = (value: string) => {
    dirtyRef.current = true;
    setDraft(value);
  };

  useEffect(() => {
    readyRef.current = false;
    dirtyRef.current = false;
    setReady(false);
    if (!roomKey) {
      setDraft("");
      setReady(true);
      readyRef.current = true;
      return;
    }
    let cancelled = false;
    void (async () => {
      let body = await loadDiscussionDraft(roomKey);
      if (!body && migrateFrom && migrateFrom !== roomKey) {
        body = await loadDiscussionDraft(migrateFrom);
        if (body) await saveDiscussionDraft(roomKey, body);
      }
      if (cancelled) return;
      setDraft((current) => acceptHydratedDraft({ incoming: body, current, userEdited: dirtyRef.current }));
      readyRef.current = true;
      setReady(true);
    })().catch(() => {
      if (!cancelled) {
        readyRef.current = true;
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [roomKey, migrateFrom]);

  useEffect(() => {
    if (!roomKey || !readyRef.current) return;
    const timer = window.setTimeout(() => {
      void saveDiscussionDraft(roomKey, draft).catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [roomKey, draft]);

  return [draft, setDraftFromUser, ready];
}
