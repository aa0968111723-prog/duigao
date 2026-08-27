/**
 * In-memory offline retry queue for cloud writes that are not whiteboard
 * nodes (nodes already retry only through IndexedDB).
 *
 * Same-key enqueue replaces the older task so a later successful edit cannot
 * be overwritten by a stale captured closure on reconnect.
 */
export type PendingWrite = {
  key: string;
  task: () => Promise<void>;
};

export function enqueuePendingWrite(queue: PendingWrite[], write: PendingWrite): PendingWrite[] {
  if (!write.key) return [...queue, write];
  return [...queue.filter((item) => item.key !== write.key), write];
}

export function acknowledgePendingWrite(queue: PendingWrite[], key: string): PendingWrite[] {
  if (!key) return queue;
  return queue.filter((item) => item.key !== key);
}

export async function flushPendingWrites(
  queue: PendingWrite[],
  isDuplicateKey: (error: unknown) => boolean,
): Promise<PendingWrite[]> {
  const retained: PendingWrite[] = [];
  for (const write of queue) {
    try {
      await write.task();
    } catch (error) {
      if (!isDuplicateKey(error)) retained.push(write);
    }
  }
  return retained;
}
