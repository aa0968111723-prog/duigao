/**
 * #113-typed whiteboard extras: image-region, plan-section, compact toolbar.
 * Run: tsx --test scripts/tests/whiteboard-board-anchors.test.ts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  nodeFromImageRegion,
  nodeFromPlanSection,
  planParagraphs,
  posterRegionMarks,
  contentOpenFromNode,
  openContentFromNode,
} from "../../src/features/collaboration/boardAnchors";
import type { Room } from "../../src/lib/types";
import type { WhiteboardNode } from "../../src/features/collaboration/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

function room(): Room {
  return {
    id: "r1",
    title: "房",
    comments: [
      {
        id: "c1",
        versionId: "v1",
        authorId: "u",
        authorName: "A",
        authorColor: "#000",
        x: 0.2,
        y: 0.2,
        region: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
        body: "主標太淡",
      },
    ],
    versions: [{ id: "v1", branchId: "b-poster", label: "A", kind: "image" } as Room["versions"][number]],
  } as Room;
}

test("poster region marks come from existing comment regions — no invented schema", () => {
  const marks = posterRegionMarks(room(), "b-poster");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].label, "主標太淡");
  assert.deepEqual(marks[0].region, { x: 0.1, y: 0.1, width: 0.3, height: 0.2 });
  assert.equal(posterRegionMarks(room(), "other").length, 0);
});

test("image-region node stores ContextAnchor on existing anchor jsonb", () => {
  const placed = nodeFromImageRegion({
    versionId: "v1",
    region: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
    label: "主標",
  });
  assert.equal((placed.anchor as { type: string }).type, "image-region");
  assert.equal(placed.sourceVersionId, "v1");
  assert.match(placed.subtitle, /主標/);
  const node = { content: {}, anchor: placed.anchor, sourceVersionId: placed.sourceVersionId } as WhiteboardNode;
  const open = contentOpenFromNode(node);
  assert.deepEqual(open.region, { x: 0.1, y: 0.2, width: 0.4, height: 0.3 });
  assert.equal(open.versionId, "v1");
});

test("plan-section uses existing plan.blocks ids; omitted blocks stay honest", () => {
  assert.deepEqual(planParagraphs({ branchId: "p", title: "t", description: "", blocks: [], blocksOmitted: true, updatedAt: 1 }), {
    omitted: true,
    blocks: [],
  });
  const paragraphs = planParagraphs({
    branchId: "p",
    title: "t",
    description: "",
    blocks: [
      { id: "s1", kind: "paragraph", text: "受眾是高中生" },
      { id: "s2", kind: "checklist", text: "核對", checked: false },
    ],
    updatedAt: 1,
  });
  assert.equal(paragraphs.omitted, false);
  assert.equal(paragraphs.blocks.length, 1);
  const placed = nodeFromPlanSection({ branchId: "p", section: { id: "s1", text: "受眾是高中生" } });
  assert.equal((placed.anchor as { type: string }).type, "plan-section");
  assert.equal(placed.link.linkedEntityType, "plan");
  assert.equal(placed.link.linkedEntityId, "p");
  assert.match(placed.subtitle ?? "", /受眾是高中生/);
});

test("openContentFromNode：圈選／影片時間／企劃段落；只有 versionId 的影片可反查 branch", () => {
  const regionPlaced = nodeFromImageRegion({
    versionId: "v1",
    region: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
    label: "主標太淡",
  });
  const poster = {
    id: "n-poster",
    whiteboardId: "b1",
    roomId: "r1",
    nodeType: "room_content",
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    content: { mediaKind: "poster", title: "擺攤文宣" },
    linkedEntityType: regionPlaced.link.linkedEntityType,
    linkedEntityId: regionPlaced.link.linkedEntityId,
    sourceVersionId: regionPlaced.sourceVersionId,
    anchor: regionPlaced.anchor,
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  } as WhiteboardNode;
  const fixture = {
    versions: [
      { id: "v1", branchId: "b-poster", label: "A", kind: "image" },
      { id: "v-vid", branchId: "b-video", label: "B", kind: "video" },
    ],
  } as Room;
  const posterOpen = openContentFromNode(poster, fixture);
  assert.equal(posterOpen.versionId, "v1");
  assert.deepEqual(posterOpen.region, { x: 0.1, y: 0.2, width: 0.4, height: 0.3 });
  assert.equal(posterOpen.branchId, "b-poster");

  const video = {
    ...poster,
    id: "n-vid",
    linkedEntityType: "version",
    linkedEntityId: "v-vid",
    sourceVersionId: "v-vid",
    anchor: undefined,
    content: { mediaKind: "video", startTime: 12, endTime: 30, title: "招生影片" },
  } as WhiteboardNode;
  const videoOpen = openContentFromNode(video, fixture);
  assert.equal(videoOpen.startTime, 12);
  assert.equal(videoOpen.branchId, "b-video");
  assert.equal(videoOpen.versionId, "v-vid");

  const planPlaced = nodeFromPlanSection({ branchId: "p", section: { id: "s1", text: "受眾是高中生" } });
  const plan = {
    ...poster,
    id: "n-plan",
    linkedEntityType: planPlaced.link.linkedEntityType,
    linkedEntityId: planPlaced.link.linkedEntityId,
    sourceVersionId: undefined,
    anchor: planPlaced.anchor,
    content: { mediaKind: "plan", subtitle: planPlaced.subtitle },
  } as WhiteboardNode;
  const planOpen = openContentFromNode(plan, fixture);
  assert.equal(planOpen.planSectionId, "s1");
  assert.equal(planOpen.branchId, "p");
});

test("workspace wires poster-region and plan-section sheets; compact toolbar under 768", () => {
  const ws = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(ws, /poster-region/);
  assert.match(ws, /plan-section/);
  assert.match(ws, /data-compact/);
  assert.match(ws, /chromeWidth < 768/);
  assert.match(ws, /posterRegionMarks|nodeFromImageRegion/);
  assert.match(ws, /planParagraphs|nodeFromPlanSection/);
  const css = src("src/features/whiteboard/whiteboard.css");
  assert.match(css, /data-compact/);
});
