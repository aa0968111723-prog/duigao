/**
 * 討論串要不要跟著最新一則走。打開房間、自己送出、或人本來就停在底部
 * 時跟著捲；人往上讀舊訊息時不要硬拉回去。
 */
export function shouldFollowLatest(args: {
  previousCount: number;
  nextCount: number;
  pinnedToLatest: boolean;
  previousLastId?: string;
  nextLastId?: string;
}): boolean {
  if (!args.nextCount || !args.nextLastId) return false;
  if (args.previousCount === 0) return true;
  if (args.nextLastId === args.previousLastId) return false;
  return args.pinnedToLatest;
}

/**
 * Feed-end on screen is not "I've read everything" if the first unread is
 * still in view, or the person just jumped to it. Marking latest in those
 * cases wipes `data-first-unread` on a short feed.
 */
export function shouldMarkLatestFromFeedEnd(args: {
  endIntersecting: boolean;
  firstUnreadInView: boolean;
  holdingFirstUnread: boolean;
}): boolean {
  if (!args.endIntersecting) return false;
  if (args.holdingFirstUnread) return false;
  if (args.firstUnreadInView) return false;
  return true;
}
