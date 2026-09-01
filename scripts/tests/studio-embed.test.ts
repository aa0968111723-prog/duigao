/**
 * 圖影編輯器鑲入契約。純函式 + 源碼證據：
 * 入口永遠可見、未設定不准假裝能開、匯出走既有上傳、不改原稿。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STUDIO_ENTRY_COPY,
  STUDIO_ENTRY_TESTID,
  fileFromStudioPayload,
  isStudioMessage,
  isStudioOrigin,
  resolveStudioOrigin,
} from "../../src/lib/studioEmbed.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("resolveStudioOrigin 去掉尾斜線與空白", () => {
  assert.equal(resolveStudioOrigin(" https://studio.example/ "), "https://studio.example");
  assert.equal(resolveStudioOrigin(""), "");
  assert.equal(resolveStudioOrigin(null), "");
});

test("isStudioOrigin 只接受 http(s)", () => {
  assert.equal(isStudioOrigin("https://studio.example"), true);
  assert.equal(isStudioOrigin("http://127.0.0.1:8080"), true);
  assert.equal(isStudioOrigin("javascript:alert(1)"), false);
  assert.equal(isStudioOrigin("/bridge"), false);
  assert.equal(isStudioOrigin(""), false);
});

test("fileFromStudioPayload：dataUrl 與 buffer", () => {
  const png = fileFromStudioPayload({
    kind: "poster",
    name: "海報",
    mime: "image/png",
    filename: "a.png",
    width: 10,
    height: 10,
    dataUrl: "data:image/png;base64,QQ==",
  });
  assert.ok(png);
  assert.equal(png.name, "a.png");
  assert.equal(png.type, "image/png");

  const buf = new Uint8Array([1, 2, 3]).buffer;
  const webm = fileFromStudioPayload({
    kind: "video",
    name: "影片",
    mime: "video/webm",
    filename: "b.webm",
    width: 1920,
    height: 1080,
    buffer: buf,
  });
  assert.ok(webm);
  assert.equal(webm.name, "b.webm");
  assert.equal(fileFromStudioPayload(null), null);
});

test("isStudioMessage 認 source=inlay", () => {
  assert.equal(isStudioMessage({ source: "inlay", type: "inlay:export" }), true);
  assert.equal(isStudioMessage({ source: "evil", type: "inlay:export" }), false);
  assert.equal(isStudioMessage(null), false);
});

test("Home 永遠畫做圖／做影入口，未設定仍可見", () => {
  const home = readFileSync(resolve(ROOT, "src/components/Home.tsx"), "utf8");
  assert.match(home, /StudioPicks/);
  assert.match(home, /onImage=\{onFiles\}/);
  assert.match(home, /onVideo=\{onVideoFiles\}/);
  const picks = readFileSync(resolve(ROOT, "src/features/studio/StudioPicks.tsx"), "utf8");
  assert.match(picks, /studio-pick-poster/);
  assert.match(picks, /studio-pick-video/);
  assert.match(picks, /STUDIO_ENTRY_COPY\["not-configured"\]/);
  assert.match(picks, /staticFileList/);
  assert.match(picks, /openStudio/);
  assert.doesNotMatch(picks, /access_token|client_secret/);
  assert.equal(STUDIO_ENTRY_COPY["not-configured"], "圖影編輯器網址尚未設定。請在環境變數填 VITE_STUDIO_ORIGIN。");
  assert.equal(STUDIO_ENTRY_TESTID.poster, "studio-pick-poster");
});

test("embed 只開 iframe、不改原稿、匯出走既有上傳", () => {
  const embed = readFileSync(resolve(ROOT, "src/lib/studioEmbed.ts"), "utf8");
  assert.match(embed, /\/bridge\?/);
  assert.match(embed, /inlay:export/);
  assert.match(embed, /原稿不被修改/);
  assert.doesNotMatch(embed, /access_token|refresh_token|CANVA_CLIENT/);
  const env = readFileSync(resolve(ROOT, ".env.example"), "utf8");
  assert.match(env, /VITE_STUDIO_ORIGIN/);
});
