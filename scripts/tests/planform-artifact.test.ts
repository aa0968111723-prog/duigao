/**
 * planform artifact 契約（PR-06）。fixture 抄 planform-iso
 * createDefaultProject() 的真實形狀（PROJECT_VERSION=8）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PLANFORM_KNOWN_VERSION,
  looksLikePlanformProject,
  planformPayloadFromSummary,
  readPlanformSummary,
} from "../../src/lib/planformArtifact";

const v8Project = (over: Record<string, unknown> = {}) => ({
  version: 8,
  id: "proj_abc123_1",
  name: "夏令營場佈",
  description: "",
  classroom: { id: "classroom", name: "教室", length: 10, width: 8, x: 0, z: 0 },
  corridor: { id: "corridor", name: "走廊", length: 10, width: 2, x: 0, z: 8 },
  tile: { width: 0.6, depth: 0.6, originX: 0, originZ: 0, rotationDeg: 0, visible: true },
  calibration: { referenceLength: null, note: "", confirmed: {} },
  zones: [{ id: "z1" }, { id: "z2" }],
  objects: [{ id: "o1" }, { id: "o2" }, { id: "o3" }],
  groups: [],
  routes: [{ id: "r1" }],
  measurements: [],
  view: "top",
  layers: { areas: true, zones: true, objects: true, tiles: true, routes: true },
  catalogExtras: [],
  scenarios: [],
  activeScenarioId: null,
  eventDate: "2026-09-12",
  ...over,
});

test("真實 v8 專案 → 完整摘要", () => {
  const summary = readPlanformSummary(v8Project());
  assert.deepEqual(summary, {
    projectId: "proj_abc123_1",
    name: "夏令營場佈",
    version: 8,
    beyondKnownVersion: false,
    zoneCount: 2,
    objectCount: 3,
    routeCount: 1,
    scenarioCount: 0,
    eventDate: "2026-09-12",
  });
});

test("v8 之前的舊檔（無 id/eventDate）→ 摘要不含缺席欄位", () => {
  const legacy = v8Project();
  delete (legacy as Record<string, unknown>).id;
  delete (legacy as Record<string, unknown>).eventDate;
  (legacy as Record<string, unknown>).version = 5;
  const summary = readPlanformSummary(legacy);
  assert.equal(summary?.projectId, undefined);
  assert.equal(summary?.eventDate, undefined);
  assert.equal(summary?.version, 5);
});

test("比讀取器新的版本：摘要照出，beyondKnownVersion 誠實標示", () => {
  const future = readPlanformSummary(v8Project({ version: PLANFORM_KNOWN_VERSION + 3 }));
  assert.equal(future?.beyondKnownVersion, true);
  assert.equal(future?.zoneCount, 2);
});

test("非 planform 的 JSON 不誤認（package.json / 任意物件 / 純量）", () => {
  assert.equal(looksLikePlanformProject({ name: "duigao", version: 1 }), false); // 無 classroom/corridor
  assert.equal(looksLikePlanformProject({ version: "8", classroom: {}, corridor: {} }), false); // version 非數字
  assert.equal(readPlanformSummary(null), null);
  assert.equal(readPlanformSummary("[]"), null);
  assert.equal(readPlanformSummary(42), null);
});

test("空名稱回退預設；超長名稱截斷", () => {
  assert.equal(readPlanformSummary(v8Project({ name: "  " }))?.name, "未命名平面圖");
  assert.equal(readPlanformSummary(v8Project({ name: "甲".repeat(300) }))?.name.length, 120);
});

test("payload 摘要：只帶呈現欄位，round-trip 穩定", () => {
  const summary = readPlanformSummary(v8Project())!;
  assert.deepEqual(planformPayloadFromSummary(summary), {
    projectId: "proj_abc123_1",
    name: "夏令營場佈",
    version: 8,
    zoneCount: 2,
    objectCount: 3,
    routeCount: 1,
  });
});
