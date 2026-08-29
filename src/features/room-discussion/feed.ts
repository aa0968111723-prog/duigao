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
