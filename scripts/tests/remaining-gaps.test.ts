/**
 * Gap-remediation handoff — proves remaining honesty gaps on origin/main
 * without editing owned product files.
 *
 * Dual-mode: on main @ 398960d the "gap still present" branch runs.
 * After #97 / #96 / #98 merge, the same assertions flip to "fix present"
 * so this file does not fail CI on those PRs.
 *
 * Run: npx tsx --test scripts/tests/remaining-gaps.test.ts
 * (no package.json script — six open PRs already edit that file)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildInviteUrl, readInviteFromUrl } from "../../src/cloud/invite.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

test("R-01: Canva/CUTOS/voice invoke data is still cast on main, or parsed after #97/#98", () => {
  const hasParser = existsSync(resolve(ROOT, "src/cloud/apiResponse.ts"));
  const canva = src("src/cloud/canva.ts");
  const cutos = src("src/cloud/cutos.ts");
  const voiceToken = src("src/cloud/voiceToken.ts");

  if (!hasParser) {
    assert.match(canva, /as CanvaBridgeHealth/, "main canvaHealth still type-asserts invoke data");
    assert.match(cutos, /as CutosBridgeHealth/, "main cutosHealth still type-asserts invoke data");
    assert.match(voiceToken, /as VoiceTokenResult/, "main fetchVoiceToken still type-asserts invoke data");
    assert.equal(existsSync(resolve(ROOT, "src/cloud/apiResponse.ts")), false);
  } else {
    const parser = src("src/cloud/apiResponse.ts");
    assert.match(parser, /html|text\/html|doctype/i, "#97 parser must reject SPA HTML");
    assert.match(canva, /parseFunctionPayload|parseApiResponse|readFunctionPayload/, "#97 must wire canva.ts");
    assert.match(cutos, /parseFunctionPayload|parseApiResponse|readFunctionPayload/, "#97 must wire cutos.ts");
    assert.match(
      voiceToken,
      /parseFunctionPayload|parseApiResponse|parseVoiceTokenPayload|wss?:/,
      "#97 or #98 must stop raw VoiceTokenResult casts on the success path",
    );
  }
});

test("R-02: Home has no honesty banner on main, or mounts homeEntryStatus after #96", () => {
  const home = src("src/components/Home.tsx");
  const hasHelper = existsSync(resolve(ROOT, "src/components/homeEntryStatus.ts"));

  if (!hasHelper) {
    assert.doesNotMatch(home, /homeEntryStatus/);
    assert.doesNotMatch(home, /home-entry-status/);
    assert.doesNotMatch(home, /目前離線/);
  } else {
    assert.match(home, /homeEntryStatus/);
    assert.match(home, /home-entry-status/);
    const helper = src("src/components/homeEntryStatus.ts");
    assert.match(helper, /offline|service-not-configured/);
    assert.doesNotMatch(helper, /已建立|已連線|分享連結已建立/);
  }
});

test("R-03: voice hook is still four-state on main, or nine-state after #98", () => {
  const hook = src("src/hooks/useVoiceRoom.ts");
  const hasMachine = existsSync(resolve(ROOT, "src/features/voice/voiceState.ts"));

  if (!hasMachine) {
    assert.match(hook, /"idle" \| "connecting" \| "live" \| "error"/);
    assert.doesNotMatch(hook, /permission-denied/);
    const copy = src("src/features/collaboration/voice.ts");
    assert.match(copy, /語音房間還在準備|語音服務尚未設定/);
  } else {
    const machine = src("src/features/voice/voiceState.ts");
    assert.match(machine, /permission-denied/);
    assert.match(machine, /service-not-configured/);
    assert.match(machine, /reconnecting/);
    assert.match(hook, /phase|voicePhaseToDockState|permission-denied/);
  }
});

test("share/invite secret stays in the fragment (evaluated — not a remaining P0)", () => {
  const prev = globalThis.location;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      origin: "https://duigao.test",
      pathname: "/",
      hash: "",
      search: "",
      href: "https://duigao.test/",
    },
  });
  try {
    const url = buildInviteUrl("room-1", "secret-token");
    assert.equal(url, "https://duigao.test/#room=room-1&invite=secret-token");
    assert.doesNotMatch(url, /\?[^#]*invite=/);
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, value: prev });
  }

  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      hash: "#room=r",
      search: "?invite=leaked",
      pathname: "/",
      origin: "https://example.test",
      href: "https://example.test/?invite=leaked#room=r",
    },
  });
  try {
    const parsed = readInviteFromUrl();
    assert.equal(parsed?.roomId, "r");
    assert.equal(parsed?.invite, null, "query invite must never become a capability secret");
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, value: prev });
  }
});
