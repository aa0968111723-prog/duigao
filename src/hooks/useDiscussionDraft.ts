import { useEffect, useRef, useState } from "react";
import { loadDiscussionDraft, saveDiscussionDraft } from "../lib/store";

/**
 * 討論輸入列草稿。IndexedDB 只是這台裝置的 cache：換房讀自己的稿，
 * 本機 id 綁成雲端 uuid 時把同一份稿遷過去。
 */
export function useDiscussionDraft(
  roomKey: string | null,
  migrateFrom?: string | null,
): [string, (value: string) => void] {
  const [draft, setDraft] = useState("");
  const readyRef = useRef(false);

  useEffect(() => {
    readyRef.current = false;
    if (!roomKey) {
      setDraft("");
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
      setDraft(body);
      readyRef.current = true;
    })().catch(() => {
      if (!cancelled) readyRef.current = true;
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

  return [draft, setDraft];
}
