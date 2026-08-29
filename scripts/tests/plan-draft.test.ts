/**
 * 企劃草稿仲裁：打字中的段落不得被「還沒存過」的空企劃洗掉。
 *
 * 這條是實抓的資料遺失（WB03 期間追 e2e 紅燈追出來的）：emptyPlan 舊版
 * 用 Date.now() 當 placeholder 時戳，room.plans 每換一次身分就生出一份
 * 「比本地新」的空企劃 → 護欄放行 → 使用者剛打的段落整批消失。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import type { PlanBlock, PlanDocument, RoomBranch } from "../../src/lib/types";
import { emptyPlan, shouldAdoptRemotePlan } from "../../src/features/multi-room/planDraft";

const branch = { id: "b1", name: "擺攤計畫", branchType: "plan", status: "active", createdAt: 1, updatedAt: 1 } as unknown as RoomBranch;
const block = (text: string): PlanBlock => ({ id: `blk-${text}`, kind: "paragraph", text }) as PlanBlock;

test("未存檔 placeholder 的時戳是 0 — 不得看起來比本地草稿新", () => {
  const placeholder = emptyPlan(branch);
  assert.equal(placeholder.updatedAt, 0);
  const typing: PlanDocument = { ...placeholder, blocks: [block("目標：招募新生")] };
  // 房態重算 → 又一份 placeholder（舊版這裡是新的 Date.now()）
  const again = emptyPlan(branch);
  assert.equal(
    shouldAdoptRemotePlan(again, typing, false),
    false,
    "空 placeholder 不得覆蓋打字中的草稿（舊版 Date.now() 讓這裡成立 → 段落消失）",
  );
});

test("有未存編輯時，連「真的比較新」的遠端也不覆蓋", () => {
  const typing: PlanDocument = { branchId: "b1", title: "擺攤計畫", description: "", blocks: [block("我正在打")], updatedAt: 0 };
  // 建立企劃分支時伺服器存的空企劃：時戳必然比草稿新
  const serverEmpty: PlanDocument = { branchId: "b1", title: "擺攤計畫", description: "", blocks: [], updatedAt: Date.now() };
  assert.equal(shouldAdoptRemotePlan(serverEmpty, typing, true), false, "打字中不得被回音洗掉");
  assert.equal(shouldAdoptRemotePlan(serverEmpty, typing, false), true, "沒在打字時，較新的遠端照常接受");
});

test("別人真的存了新版才接受；自己較新時保留本地", () => {
  const local: PlanDocument = { branchId: "b1", title: "擺攤計畫", description: "", blocks: [block("我打的")], updatedAt: 1000 };
  const remoteNewer: PlanDocument = { ...local, blocks: [block("同事存的")], updatedAt: 2000 };
  const remoteOlder: PlanDocument = { ...local, blocks: [block("舊的")], updatedAt: 500 };
  assert.equal(shouldAdoptRemotePlan(remoteNewer, local, false), true, "遠端較新要接受");
  assert.equal(shouldAdoptRemotePlan(remoteOlder, local, false), false, "遠端較舊要保留本地");
  // 同時戳（同一份回音）：不動，避免游標/焦點被無謂重置
  assert.equal(shouldAdoptRemotePlan({ ...local }, local, false), false, "相同時戳的回音不重置草稿");
});
