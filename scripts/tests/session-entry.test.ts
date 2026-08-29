/**
 * Session / empty-room / auth-loading / permission-denied honesty.
 * Stacked on #95 — does not replace TUS, discussion, or MultiBranchRoom.
 *
 * Run: npm run test:session-entry
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CloudError, isInvalidInvite, isPermissionDenied } from "../../src/cloud/errors.ts";
import { sessionEntryStatus } from "../../src/cloud/sessionEntryStatus.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

const guestBase = {
  isCloudGuest: true,
  isLegacyLink: false,
  collabStatus: null as string | null,
  inviteInvalid: false,
  permissionDenied: false,
  hasVersions: false,
  projectMode: false,
};

test("auth-loading: connecting is not an empty room and not a fake ready state", () => {
  const entry = sessionEntryStatus({ ...guestBase, cloudStatus: "connecting" });
  assert.equal(entry.kind, "auth-loading");
  assert.match(entry.headline, /確認身分|進入房間/);
  assert.doesNotMatch(entry.headline, /已連線|分享連結已建立|還沒有文宣/);
  assert.equal(entry.retry, "none");
});

test("room-loading: syncing stays a load, not an error retry", () => {
  const entry = sessionEntryStatus({ ...guestBase, cloudStatus: "syncing" });
  assert.equal(entry.kind, "room-loading");
  assert.match(entry.headline, /載入房間/);
  assert.doesNotMatch(entry.headline, /已連線/);
  assert.equal(entry.retry, "none");
});

test("empty-room: synced with zero versions must not stay on 正在載入", () => {
  const entry = sessionEntryStatus({ ...guestBase, cloudStatus: "synced" });
  assert.equal(entry.kind, "empty-room");
  assert.match(entry.headline, /還沒有文宣|還沒有影片|空/);
  assert.doesNotMatch(entry.headline, /正在載入/);
  assert.doesNotMatch(entry.headline, /已連線|分享連結已建立/);
  assert.equal(entry.retry, "none");
});

test("permission-denied is distinct from invite-invalid and generic retry", () => {
  const entry = sessionEntryStatus({
    ...guestBase,
    cloudStatus: "error",
    permissionDenied: true,
    inviteInvalid: false,
  });
  assert.equal(entry.kind, "permission-denied");
  assert.match(entry.headline, /沒有權限/);
  assert.doesNotMatch(entry.headline, /正在載入/);
  assert.equal(entry.retry, "none");
});

test("invite-invalid wins over a generic error and does not claim the room is loading", () => {
  const entry = sessionEntryStatus({
    ...guestBase,
    cloudStatus: "error",
    inviteInvalid: true,
  });
  assert.equal(entry.kind, "invite-invalid");
  assert.match(entry.headline, /無效|失效/);
  assert.equal(entry.retry, "none");
});

test("legacy stalled stays the old-link story, not permission-denied", () => {
  const entry = sessionEntryStatus({
    ...guestBase,
    isCloudGuest: false,
    isLegacyLink: true,
    cloudStatus: "local-only",
    collabStatus: "waiting",
  });
  assert.equal(entry.kind, "legacy-stalled");
  assert.match(entry.headline, /舊版/);
  assert.equal(entry.retry, "legacy");
});

test("projectMode or versions mean the helper is not the owner of the screen", () => {
  assert.equal(sessionEntryStatus({ ...guestBase, cloudStatus: "synced", projectMode: true }).kind, "ready");
  assert.equal(sessionEntryStatus({ ...guestBase, cloudStatus: "synced", hasVersions: true }).kind, "ready");
});

test("isPermissionDenied does not reclassify invalid invite (no room-existence leak)", () => {
  assert.equal(isInvalidInvite(new CloudError("invalid invite", "join")), true);
  assert.equal(isPermissionDenied(new CloudError("invalid invite", "join")), false);
  assert.equal(isPermissionDenied(new CloudError("new row violates row-level security policy", "load")), true);
  assert.equal(isPermissionDenied(new CloudError("42501", "load")), true);
  assert.equal(isPermissionDenied(new CloudError("permission denied for schema auth", "load")), false);
});

test("App onboard mounts sessionEntryStatus and permissionDenied", () => {
  const app = src("src/App.tsx");
  const hook = src("src/cloud/useCloudRoom.ts");
  assert.match(app, /sessionEntryStatus/);
  assert.match(app, /data-testid="session-entry-status"/);
  assert.match(hook, /permissionDenied/);
  assert.match(hook, /isPermissionDenied/);
});
