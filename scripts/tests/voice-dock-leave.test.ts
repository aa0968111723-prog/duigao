import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { voiceDockShowsLeave } from "../../src/features/room-discussion/voiceDockLeave.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Leave stays visible while live or reconnecting; idle/error do not keep a fake session", () => {
  assert.equal(voiceDockShowsLeave("live"), true);
  assert.equal(voiceDockShowsLeave("reconnecting"), true);
  assert.equal(voiceDockShowsLeave("idle"), false);
  assert.equal(voiceDockShowsLeave("error"), false);
  assert.equal(voiceDockShowsLeave("connecting"), false);
  assert.equal(voiceDockShowsLeave("service-not-configured"), false);
});

test("RoomDiscussion dock uses the leave helper, not live-only", () => {
  const dock = readFileSync(resolve(ROOT, "src/features/room-discussion/RoomDiscussion.tsx"), "utf8");
  assert.match(dock, /voiceDockShowsLeave/);
  assert.match(dock, /data-testid="voice-leave"/);
  assert.doesNotMatch(dock, /voice\.state === "live" \?/);
});
