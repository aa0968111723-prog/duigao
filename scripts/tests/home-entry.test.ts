import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { homeEntryStatus } from "../../src/components/homeEntryStatus.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("positive: online + configured (or local dev) is ok", () => {
  assert.deepEqual(homeEntryStatus({ online: true, cloudConfigured: true, productionBuild: true }), {
    kind: "ok",
    message: null,
  });
  const localDev = homeEntryStatus({ online: true, cloudConfigured: false, productionBuild: false });
  assert.equal(localDev.kind, "ok");
  assert.equal(localDev.message, null, "local mode must not show a fake cloud-ready banner");
});

test("local-dev without keys still keeps IndexedDB fallback — no 分享連結已建立 copy", () => {
  const status = homeEntryStatus({ online: true, cloudConfigured: false, productionBuild: false });
  assert.equal(status.kind, "ok");
  assert.equal(status.message, null);
});

test("negative: offline is never a fake ready room", () => {
  const status = homeEntryStatus({ online: false, cloudConfigured: true, productionBuild: true });
  assert.equal(status.kind, "offline");
  assert.match(status.message ?? "", /目前離線/);
  assert.doesNotMatch(status.message ?? "", /已建立|已連線|成功/);
});

test("negative: production without cloud keys is 服務尚未設定", () => {
  const status = homeEntryStatus({ online: true, cloudConfigured: false, productionBuild: true });
  assert.equal(status.kind, "service-not-configured");
  assert.match(status.message ?? "", /尚未設定/);
  assert.doesNotMatch(status.message ?? "", /分享連結已建立/);
});

test("offline wins over missing keys (do not hide the network fact)", () => {
  const status = homeEntryStatus({ online: false, cloudConfigured: false, productionBuild: true });
  assert.equal(status.kind, "offline");
});

test("Home mounts the status helper and does not invent a second chat", () => {
  const home = readFileSync(resolve(ROOT, "src/components/Home.tsx"), "utf8");
  assert.match(home, /homeEntryStatus/);
  assert.match(home, /home-entry-status/);
  assert.doesNotMatch(home, /createChat|newChatSystem/);
});
