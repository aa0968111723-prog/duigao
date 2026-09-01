/**
 * 圖影編輯器鑲入契約。純函式 + 源碼證據：
 * 對稿自己就是編輯器、入口永遠可見、匯出走既有上傳、不改原稿。
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
  isStudioConfigured,
  isStudioMessage,
  isStudioOrigin,
  parseStudioHash,
  resolveStudioOrigin,
} from "../../src/lib/studioEmbed.ts";
import { blankDesign, scaleDesign } from "../../src/features/studio/studioModel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("resolveStudioOrigin 掉掉尾斜線與空白", () => {
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

test("isStudioConfigured 永遠為 true：對稿自己就是編輯器", () => {
  assert.equal(isStudioConfigured(), true);
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

test("parseStudioHash 認 #studio，不跟 #room= 搶", () => {
  const poster = parseStudioHash("#studio");
  assert.ok(poster);
  assert.equal(poster.kind, "poster");
  assert.equal(poster.embed, false);
  const video = parseStudioHash("#studio?kind=video&embed=1");
  assert.ok(video);
  assert.equal(video.kind, "video");
  assert.equal(video.embed, true);
  assert.equal(parseStudioHash("#room=abc123"), null);
  assert.equal(parseStudioHash("#studio?room=abc"), null);
});

test("scaleDesign 會跟著縮放物件與字級", () => {
  const d = blankDesign("poster", "測", 1000, 1000);
  d.elements = [
    {
      id: "t1",
      name: "標題",
      type: "text",
      x: 100,
      y: 100,
      width: 400,
      height: 80,
      rotation: 0,
      opacity: 1,
      locked: false,
      hidden: false,
      appearAt: 0,
      disappearAt: 0,
      content: "Hi",
      fontFamily: "Noto Sans TC",
      fontSize: 40,
      fontWeight: 700,
      color: "#000",
      align: "left",
      italic: false,
    },
  ];
  const next = scaleDesign(d, 2000, 500);
  assert.equal(next.width, 2000);
  assert.equal(next.height, 500);
  assert.equal(next.elements[0].x, 200);
  assert.equal(next.elements[0].y, 50);
  assert.equal(next.elements[0].width, 800);
  assert.equal(next.elements[0].type, "text");
  if (next.elements[0].type === "text") {
    assert.equal(next.elements[0].fontSize, 20);
  }
});

test("Home 永遠畫做圖／做影入口，匯出走既有上傳", () => {
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
  assert.equal(STUDIO_ENTRY_TESTID.poster, "studio-pick-poster");
  assert.ok(STUDIO_ENTRY_COPY["not-configured"].length > 0);
});

test("原生編輯器在對稿裡：StudioApp、StudioRoot、open-studio", () => {
  const embed = readFileSync(resolve(ROOT, "src/lib/studioEmbed.ts"), "utf8");
  assert.match(embed, /duigao:open-studio/);
  assert.match(embed, /#studio/);
  assert.match(embed, /\/bridge\?/);
  assert.match(embed, /inlay:export/);
  assert.match(embed, /原稿不被修改/);
  assert.match(embed, /isStudioConfigured/);
  assert.doesNotMatch(embed, /access_token|refresh_token|CANVA_CLIENT/);
  const app = readFileSync(resolve(ROOT, "src/features/studio/StudioApp.tsx"), "utf8");
  assert.match(app, /studio-app/);
  assert.match(app, /完成，送到對稿/);
  const root = readFileSync(resolve(ROOT, "src/features/studio/StudioRoot.tsx"), "utf8");
  assert.match(root, /StudioApp/);
  assert.match(root, /duigao:open-studio/);
  assert.match(root, /parseStudioHash/);
  const main = readFileSync(resolve(ROOT, "src/main.tsx"), "utf8");
  assert.match(main, /StudioRoot/);
  const env = readFileSync(resolve(ROOT, ".env.example"), "utf8");
  assert.match(env, /VITE_STUDIO_ORIGIN/);
});
