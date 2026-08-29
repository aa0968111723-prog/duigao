import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  FIRST_LAYER_TABS,
  FIRST_LAYER_TOP,
  PHONE_WIDTHS,
  firstLayerChrome,
  firstLayerHasPersistentSecondary,
  isTabletSplitWidth,
} from "../../src/features/multi-room/roomChrome.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

test("360 first layer never has persistent 總覽 / AI / 檔案 tabs", () => {
  for (const width of PHONE_WIDTHS) {
    const layer = firstLayerChrome({ moreOpen: false, width });
    assert.deepEqual([...layer.tabs], ["對話", "白板"]);
    assert.equal(firstLayerHasPersistentSecondary(layer), false);
    assert.deepEqual(layer.visibleSecondary, []);
    assert.equal(layer.persistentSecondary.includes("總覽"), false);
    assert.equal(layer.persistentSecondary.includes("AI"), false);
    assert.equal(layer.persistentSecondary.includes("檔案"), false);
  }
});

test("more reveals secondary; tablet 768/820 can split when more is open", () => {
  const phone = firstLayerChrome({ moreOpen: true, width: 360 });
  assert.ok(phone.visibleSecondary.includes("總覽"));
  assert.ok(phone.visibleSecondary.includes("AI"));
  assert.equal(phone.tabletSplit, false);
  assert.equal(isTabletSplitWidth(768), true);
  assert.equal(isTabletSplitWidth(820), true);
  assert.equal(firstLayerChrome({ moreOpen: true, width: 768 }).tabletSplit, true);
  assert.equal(firstLayerChrome({ moreOpen: true, width: 820 }).tabletSplit, true);
  assert.deepEqual([...FIRST_LAYER_TOP], ["back", "title", "presence", "voice", "more"]);
  assert.deepEqual([...FIRST_LAYER_TABS], ["對話", "白板"]);
});

test("shell first layer is gated by more, not permanently painted", () => {
  const shell = src("src/features/multi-room/MultiBranchRoom.tsx");
  assert.match(shell, /data-testid="room-more"/);
  assert.match(shell, /data-testid="room-more-sheet"/);
  assert.match(shell, /data-testid="room-presence"/);
  assert.match(shell, /data-testid="room-voice-chip"/);
  assert.match(shell, /moreOpen/);
  assert.match(shell, /open-\$\{item\.id\}-pane|open-overview-pane/);
  // Secondary chrome must not render on the first layer.
  assert.match(shell, /moreOpen && \(/);
  assert.doesNotMatch(shell, /project-entry-chips[\s\S]{0,80}hidden=\{hideRoomChrome\}/);
  assert.match(shell, /popstate|duigaoMore/);
});

test("safe area, keyboard, 44px touch, overflow, reduced motion, orientation", () => {
  const css = [src("src/styles.css"), src("src/mobile.css"), src("src/features/room-discussion/discussion.css")].join("\n");
  const hook = src("src/hooks/useViewport.ts");
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /--kb/);
  assert.match(hook, /orientationchange/);
  assert.match(hook, /visualViewport/);
  assert.match(css, /room-more[\s\S]{0,120}min-(width|height):\s*44px|min-height:\s*44px[\s\S]{0,80}room-more/);
  assert.match(css, /\.project-room[^{]*\{[^}]*overflow-x:\s*(hidden|clip)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  const shell = src("src/features/multi-room/MultiBranchRoom.tsx");
  assert.match(shell, /is-tablet-split|data-tablet-split|tabletSplit/);
  assert.match(shell, /onContextMenu|duigaoMore/);
  assert.match(css, /-webkit-touch-callout:\s*none/);
});

test("collaboration e2e opens content pane via 更多, not a first-layer button", () => {
  const e2e = src("scripts/e2e/collaboration-workspace.mjs");
  assert.match(e2e, /openRoomPane\(page, "open-content-pane"\)/);
  assert.doesNotMatch(e2e, /getByTestId\(["']open-content-pane["']\)\.click\(/);
});

test("popstate that closes 更多 must not also wipe the pushed pane", () => {
  const shell = src("src/features/multi-room/MultiBranchRoom.tsx");
  assert.match(shell, /historyLayers\(\)\.push\("content-overlay"/);
  const pop = shell.match(/const onPop = \(\) => \{[\s\S]*?addEventListener\("popstate"/);
  assert.ok(pop, "more-sheet popstate listener");
  assert.match(pop[0], /moreOpenRef\.current/);
  assert.doesNotMatch(pop[0], /setPushedPane\(null\)/);
});

test("negative control: a first layer that always paints 總覽 would fail the helper", () => {
  const honest = firstLayerChrome({ moreOpen: false, width: 360 });
  assert.equal(firstLayerHasPersistentSecondary(honest), false);
  const naive = { ...honest, persistentSecondary: ["總覽", "AI", "檔案"] };
  assert.equal(firstLayerHasPersistentSecondary(naive), true);
});
