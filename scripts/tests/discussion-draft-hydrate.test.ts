import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acceptHydratedDraft } from "../../src/hooks/useDiscussionDraft";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("hydrate does not wipe a draft the person already typed", () => {
  assert.equal(
    acceptHydratedDraft({ incoming: "", current: "drawer 打個招呼", userEdited: true }),
    "drawer 打個招呼",
  );
  assert.equal(
    acceptHydratedDraft({ incoming: "舊稿", current: "drawer 打個招呼", userEdited: true }),
    "drawer 打個招呼",
  );
});

test("hydrate restores a saved draft when the field is still empty, which enables 送出", () => {
  assert.equal(acceptHydratedDraft({ incoming: "上次沒送出", current: "", userEdited: false }), "上次沒送出");
  assert.equal(acceptHydratedDraft({ incoming: "", current: "", userEdited: false }), "");
  assert.equal(Boolean("上次沒送出".trim()), true);
});

test("drawer waits for draft-ready; 送出 stays gated on trimmed draft", () => {
  const hook = readFileSync(resolve(ROOT, "src/hooks/useDiscussionDraft.ts"), "utf8");
  const drawer = readFileSync(resolve(ROOT, "src/features/room-discussion/DiscussionDrawer.tsx"), "utf8");
  const composer = readFileSync(resolve(ROOT, "src/features/room-discussion/RoomDiscussion.tsx"), "utf8");
  const e2e = readFileSync(resolve(ROOT, "scripts/e2e/review-viewer.mjs"), "utf8");
  assert.match(hook, /acceptHydratedDraft/);
  assert.match(hook, /userEdited: dirtyRef\.current/);
  assert.match(drawer, /data-draft-ready=\{draftReady \? "true" : "false"\}/);
  assert.match(composer, /disabled=\{!api\.draft\.trim\(\)\}/);
  assert.match(composer, />送出</);
  assert.match(e2e, /data-testid="discussion-drawer"\]\[data-draft-ready="true"\]/);
  assert.match(e2e, /送出在草稿 hydrate 後可按/);
  assert.doesNotMatch(e2e, /for \(let attempt = 0; attempt < 8/);
});
