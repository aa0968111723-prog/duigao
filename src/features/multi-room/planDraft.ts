import type { PlanDocument, RoomBranch } from "../../lib/types";

/**
 * 企劃編輯器的「遠端 vs 本地草稿」仲裁（純函式，好測）。
 *
 * room.plans 的陣列身分每次快照都會變，無條件接受遠端會把「打字中、還沒
 * 按完成」的段落洗掉；反過來無條件保留本地，別人存的版本就永遠進不來。
 * 規則：**只有真的比較新才接受**。
 */
export function shouldAdoptRemotePlan(
  remote: PlanDocument,
  local: PlanDocument,
  localDirty: boolean,
): boolean {
  // 有未存編輯就永不覆蓋 — 只比時戳擋不住這條真實序列：建立企劃分支時
  // 伺服器會存一份「空的、時戳是現在」的企劃文件，它必然比使用者草稿新；
  // 只要這份回音在打字之後才落地，段落就整批消失（e2e 隨機紅的真因）。
  // 使用者按「完成」時本地就是權威；並發合併屬另一輪的範圍。
  if (localDirty) return false;
  return remote.updatedAt > local.updatedAt;
}

/**
 * 「這份企劃還沒存過」的 placeholder。
 *
 * updatedAt 必須是 0：給它 Date.now() 的話，每次 room.plans 換身分就生出
 * 一份「比本地新」的空企劃，shouldAdoptRemotePlan 判 true → 使用者正在打
 * 的段落整批消失（真實資料遺失，平常被時序遮住）。真正存檔時「完成」鈕
 * 會蓋上 Date.now()，所以 0 不影響任何顯示或排序。
 */
export function emptyPlan(branch: RoomBranch): PlanDocument {
  return { branchId: branch.id, title: branch.name, description: "", blocks: [], updatedAt: 0 };
}
