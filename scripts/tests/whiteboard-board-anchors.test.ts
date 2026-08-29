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

test("workspace wires poster-region and plan-section sheets; compact toolbar under 768", () => {
  const ws = src("src/features/whiteboard/WhiteboardWorkspace.tsx");
  assert.match(ws, /poster-region/);
  assert.match(ws, /plan-section/);
  assert.match(ws, /data-compact/);
  assert.match(ws, /posterRegionMarks|nodeFromImageRegion/);
  assert.match(ws, /planParagraphs|nodeFromPlanSection/);
  const css = src("src/features/whiteboard/whiteboard.css");
  assert.match(css, /data-compact/);
});
