import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { branchOpenCommentCount, normalizeRoomBranches } from "../../src/lib/roomBranches.ts";
import type { Room, RoomBranch } from "../../src/lib/types.ts";
import type { VisualProposal } from "../../src/features/visual-proposal/store.ts";
import { mergeProposalDocsForHydrate } from "../../src/features/visual-proposal/mergeHydrate.ts";
import { isComposePaperVersion } from "../../src/features/visual-proposal/composePaper.ts";
import {
  listComposeMaterials,
  placeComposeMaterial,
} from "../../src/features/visual-proposal/composeMaterials.ts";
import {
  appendVersionWithoutOverwrite,
  canSaveComposeVersion,
  cloneProposalDocsToVersion,
  composeHasContent,
  composeSaveOrReject,
  nextPosterVersionLabel,
  versionIdentitiesUnchanged,
  type VersionIdentity,
} from "../../src/features/visual-proposal/saveComposeVersion.ts";
import { FONT_STYLES } from "../../src/features/visual-proposal/helpers.ts";
import { COMPOSE_FONT_FACES } from "../../src/features/visual-proposal/composeFonts.ts";
import { imageItemFromCatalogHit, searchOpenStickers } from "../../src/features/visual-proposal/openCatalog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function emptyDoc(over: Partial<VisualProposal> = {}): VisualProposal {
  return {
    id: "vp_1",
    versionId: "v_old",
    name: "工作層",
    title: "工作層",
    description: "",
    type: "layout",
    status: "draft",
    createdBy: "u1",
    authorName: "主辦",
    supports: [],
    comments: [],
    items: [],
    background: {
      color: "#000000",
      colorOpacity: 0,
      gradient: "none",
      gradientFrom: "#000",
      gradientTo: "#000",
      gradientOpacity: 0,
      imageOpacity: 1,
      imageFit: "cover",
    },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("hydrate 保留記憶體較新的工作層與只存在記憶體的文件", () => {
  const savedOlder = emptyDoc({ id: "shared", title: "磁碟舊稿", name: "磁碟舊稿", updatedAt: 10 });
  const memoryNewer = emptyDoc({ id: "shared", title: "剛編輯的稿", name: "剛編輯的稿", updatedAt: 20 });
  const memoryOnly = emptyDoc({ id: "memory-only", title: "尚未落盤", name: "尚未落盤", updatedAt: 30 });
  const merged = mergeProposalDocsForHydrate([memoryNewer, memoryOnly], [savedOlder]);
  assert.equal(merged.find((doc) => doc.id === "shared")?.title, "剛編輯的稿");
  assert.equal(merged.some((doc) => doc.id === "memory-only"), true);
});

test("hydrate race 修補接到 store 與 mobile dock", () => {
  const store = src("src/features/visual-proposal/store.ts");
  const mobile = src("src/features/image-review/MobileWorkspace.tsx");
  assert.match(store, /mergeProposalDocsForHydrate/);
  assert.match(store, /hydrateQueued/);
  assert.match(store, /layerEditing:\s*state\.editing/);
  assert.match(mobile, /proposalStore\.layerEditing/);
  assert.match(mobile, /proposalSession\?\.intent === null && api\.canManage && !proposalStore\.active/);
  assert.match(mobile, /visibleVersionId/);
  assert.match(mobile, /useProposalStore\(room\.id, visibleVersionId/);
});

test("新增文宣 sheet 有上傳成品與用素材拼一張入口", () => {
  const sheet = src("src/features/multi-room/MultiBranchRoom.tsx");
  assert.match(sheet, /data-testid="create-poster-upload"/);
  assert.match(sheet, /data-testid="create-poster-compose"/);
  assert.match(sheet, /用素材拼一張/);
  assert.match(sheet, /compose:\s*true/);
  assert.doesNotMatch(sheet, /FIRST_LAYER_TABS/);
});

test("丟素材先快照 FileList，不清空 input 再讀（live FileList 會變空）", () => {
  const dock = src("src/features/visual-proposal/ProposalDock.tsx");
  const snapAt = dock.indexOf("const list = files ? Array.from(files)");
  const clearAt = dock.indexOf("materialRef.current.value = \"\"");
  assert.ok(snapAt >= 0 && clearAt > snapAt);
});

test("未 canManage 沒有編輯這張或存成新版本", () => {
  const mobile = src("src/features/image-review/MobileWorkspace.tsx");
  const desktop = src("src/features/image-review/DesktopWorkspace.tsx");
  const controls = src("src/features/visual-proposal/ProposalControls.tsx");
  const dock = src("src/features/visual-proposal/ProposalDock.tsx");
  for (const file of [mobile, desktop]) {
    assert.match(file, /api\.canManage && \(/);
    assert.match(file, /data-testid="poster-edit-toggle"/);
    assert.match(file, /編輯這張/);
  }
  assert.match(controls, /canManage &&/);
  assert.match(controls, /poster-save-version/);
  assert.match(dock, /canManage &&/);
  assert.match(dock, /poster-save-version/);
  assert.match(dock, /proposal\.setEditing\(canManage\)/);
});

test("compose 單一皮：Dock 五鍵、完成出口、無 pin 鍵", () => {
  const desktop = src("src/features/image-review/DesktopWorkspace.tsx");
  const mobile = src("src/features/image-review/MobileWorkspace.tsx");
  const dock = src("src/features/visual-proposal/ProposalDock.tsx");
  assert.match(desktop, /composing \? \(/);
  assert.match(desktop, /ProposalDock/);
  assert.match(desktop, /layerEditing/);
  assert.doesNotMatch(desktop, /ProposalControls/);
  assert.match(desktop, /composing \? \([\s\S]*?<ProposalDock[\s\S]*?: \([\s\S]*className="toolbar"/);
  assert.doesNotMatch(desktop, /composing \? \([\s\S]*?修改點[\s\S]*?<ProposalDock/);
  assert.match(mobile, /proposalSession \? \([\s\S]*?<ProposalDock[\s\S]*?: \([\s\S]*sheetVisible/);
  assert.doesNotMatch(mobile, /proposalSession \? \([\s\S]*?>修改<\/[\s\S]*?<ProposalDock/);
  assert.match(dock, /＋文字/);
  assert.match(dock, /＋素材/);
  assert.match(dock, /比較/);
  assert.match(dock, /存成新版本/);
  assert.match(dock, /data-testid="compose-exit"/);
  assert.match(dock, /data-testid="poster-save-version"/);
  const barAt = dock.indexOf("className=\"pdock-bar\"");
  const pinInBar = dock.slice(barAt).indexOf("修改點");
  assert.equal(pinInBar < 0, true);
  const saveAbove = dock.indexOf("poster-save-version");
  assert.ok(saveAbove > barAt);
});

test("App 存成新版本走 shipped composeSaveOrReject，不是旁路重寫", () => {
  const app = src("src/App.tsx");
  assert.match(app, /composeSaveOrReject/);
  assert.match(app, /canSaveComposeVersion/);
  assert.match(app, /stableId: nextId/);
  assert.match(app, /writes\.addVersion/);
  assert.doesNotMatch(app, /image_path:.+oldVersion/);
});

test("saveNewVersion 後舊 version id／圖路徑不變，新 version 存在", () => {
  const old: VersionIdentity = {
    id: "v_old",
    label: "初稿",
    imageDataUrl: "data:image/png;base64,OLDOLDOLDOLDOLDOLDOLDOLD",
    imagePath: "rooms/r1/v_old.png",
  };
  const withImage = emptyDoc({
    items: [{
      id: "vpi_1",
      type: "image",
      name: "社徽",
      imageDataUrl: "data:image/png;base64,ABC",
      x: 0.5, y: 0.5, width: 32, rotation: 0, opacity: 1, visible: true,
    }],
  });
  const next: VersionIdentity = {
    id: "v_new",
    label: nextPosterVersionLabel(1),
    imageDataUrl: "data:image/png;base64,NEWCOMPOSENEWCOMPOSENEW",
    imagePath: "rooms/r1/v_new.png",
  };
  const saved = composeSaveOrReject({ doc: withImage, versions: [old], next });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.versions.length, 2);
  assert.equal(saved.versions[1].id, "v_new");
  assert.equal(saved.versions[1].label, "改一");
  assert.equal(versionIdentitiesUnchanged([old], saved.versions, "v_old"), true);
  assert.equal(saved.versions[0].imagePath, "rooms/r1/v_old.png");
  assert.notEqual(saved.versions[1].id, old.id);
  assert.notEqual(saved.versions[1].imagePath, old.imagePath);

  const sameId = composeSaveOrReject({ doc: withImage, versions: [old], next: { ...old, label: "改一" } });
  assert.equal(sameId.ok, false);
  assert.equal(appendVersionWithoutOverwrite([old], { ...old, label: "改一" }).ok, false);
});

test("空畫布不能存成新版本、不可寫空檔冒充成功", () => {
  assert.equal(composeHasContent(emptyDoc()), false);
  const empty = canSaveComposeVersion(emptyDoc());
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /空/);

  const old: VersionIdentity = {
    id: "v_old",
    label: "初稿",
    imageDataUrl: "data:image/png;base64,OLDOLDOLDOLDOLDOLDOLDOLD",
  };
  const rejected = composeSaveOrReject({
    doc: emptyDoc(),
    versions: [old],
    next: {
      id: "v_blank",
      label: "改一",
      imageDataUrl: "data:image/png;base64,NEWCOMPOSENEWCOMPOSENEW",
    },
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.reason, /空/);

  const withImage = emptyDoc({
    items: [{
      id: "vpi_1",
      type: "image",
      name: "社徽",
      imageDataUrl: "data:image/png;base64,ABC",
      x: 0.5, y: 0.5, width: 32, rotation: 0, opacity: 1, visible: true,
    }],
  });
  assert.equal(canSaveComposeVersion(withImage).ok, true);

  const blankFile = composeSaveOrReject({
    doc: withImage,
    versions: [old],
    next: { id: "v_blank", label: "改一", imageDataUrl: "" },
  });
  assert.equal(blankFile.ok, false);
});

test("複製工作層到新 version 時舊 version 的提案仍在", () => {
  const docs = [emptyDoc({
    items: [{
      id: "vpi_keep",
      type: "image",
      name: "社徽",
      imageDataUrl: "data:image/png;base64,ABC",
      x: 0.4, y: 0.4, width: 20, rotation: 0, opacity: 1, visible: true,
    }],
  })];
  const next = cloneProposalDocsToVersion(docs, "v_old", "v_new");
  assert.equal(next.length, 2);
  assert.equal(next[0].versionId, "v_old");
  assert.equal(next[0].id, "vp_1");
  assert.equal(next[0].items[0].id, "vpi_keep");
  assert.equal(next[1].versionId, "v_new");
  assert.notEqual(next[1].id, "vp_1");
  assert.notEqual(next[1].items[0].id, "vpi_keep");
});

test("新版出現後舊版待處理則數仍掛在被留言的 version", () => {
  const poster: RoomBranch = {
    id: "br_poster",
    roomId: "room-1",
    name: "茶會文宣",
    branchType: "poster",
    sortOrder: 0,
    status: "in_progress",
    createdBy: "owner",
    createdAt: 1,
    updatedAt: 2,
  };
  const room: Room = {
    id: "room-1",
    title: "活動房",
    projectMode: true,
    branches: [poster],
    versions: [
      { id: "v_old", label: "初稿", imageDataUrl: "data:old", branchId: poster.id },
      { id: "v_new", label: "改一", imageDataUrl: "data:new", branchId: poster.id },
    ],
    comments: [
      { id: "c1", versionId: "v_old", authorId: "a", authorName: "A", authorColor: "#000", x: 0.2, y: 0.3, body: "改標題", resolved: false, createdAt: 1 },
      { id: "c2", versionId: "v_old", authorId: "a", authorName: "A", authorColor: "#000", x: 0.4, y: 0.5, body: "放大 logo", resolved: false, createdAt: 2 },
    ],
    strokes: [],
    messages: [],
    updatedAt: 2,
  };
  const normalized = normalizeRoomBranches(room);
  assert.equal(branchOpenCommentCount(normalized, poster.id), 2);
});

test("Canva 同步走 appendVersionWithoutOverwrite 精神：舊 id／path 留下", () => {
  const old: VersionIdentity = {
    id: "v_canva_old",
    label: "Canva 招生海報",
    imageDataUrl: "data:image/png;base64,OLDCANVACANVACANVACANVA",
    imagePath: "rooms/r1/versions/v_canva_old/poster.png",
  };
  const next: VersionIdentity = {
    id: "v_canva_new",
    label: "改一",
    imageDataUrl: "data:image/png;base64,NEWCANVACANVACANVACANVA",
    imagePath: "rooms/r1/versions/v_canva_new/poster.png",
  };
  const saved = appendVersionWithoutOverwrite([old], next);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.versions.length, 2);
  assert.equal(versionIdentitiesUnchanged([old], saved.versions, "v_canva_old"), true);
  assert.notEqual(saved.versions[1].id, old.id);
  assert.notEqual(saved.versions[1].imagePath, old.imagePath);
  const app = src("src/App.tsx");
  assert.match(app, /importFromCanva\(version\.canvaDesignId/);
  assert.match(app, /nextPosterVersionLabel/);
});

test("畫布與存檔走既有 testid，不改第一層 IA", () => {
  const overlay = src("src/features/visual-proposal/VisualProposalOverlay.tsx");
  const stage = src("src/features/image-review/Stage.tsx");
  const chrome = src("src/features/multi-room/roomChrome.ts");
  assert.match(overlay, /data-testid="poster-compose-canvas"/);
  assert.match(stage, /data-testid="poster-compose-stage"/);
  assert.match(chrome, /FIRST_LAYER_TABS = \["對話", "白板"\]/);
  assert.match(chrome, /FIRST_LAYER_TOP = \["back", "title", "presence", "voice", "more"\]/);
});

test("開源圖庫搜尋 fixture 落成 raster image item，不是 SVG 存檔", () => {
  const hits = searchOpenStickers("茶");
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].name);
  const item = imageItemFromCatalogHit(hits[0]);
  assert.equal(item.type, "image");
  assert.equal(item.visible, true);
  assert.match(item.imageDataUrl, /^data:image\/(png|webp|jpe?g)/i);
  assert.doesNotMatch(item.imageDataUrl, /image\/svg\+xml/);
  assert.throws(
    () => imageItemFromCatalogHit({
      id: "bad",
      name: "向量",
      tags: [],
      pngDataUrl: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    }),
    /PNG/,
  );
  const fixtureHits = searchOpenStickers("自訂", [{
    id: "fx",
    name: "自訂貼圖",
    tags: ["fixture"],
    pngDataUrl: "data:image/webp;base64,AAA",
  }]);
  assert.equal(fixtureHits.length, 1);
  assert.equal(fixtureHits[0].name, "自訂貼圖");
});

test("圖庫落下的可見圖讓 composeHasContent 為真；空畫布仍拒絕", () => {
  const hit = searchOpenStickers("茶")[0];
  const item = imageItemFromCatalogHit(hit);
  const withSticker = emptyDoc({ items: [item] });
  assert.equal(composeHasContent(withSticker), true);
  assert.equal(canSaveComposeVersion(withSticker).ok, true);
  assert.equal(composeHasContent(emptyDoc()), false);
  assert.equal(canSaveComposeVersion(emptyDoc()).ok, false);
});

test("六種字體感覺都有可載入的繁中 webfont；手寫感不是系統楷體", () => {
  assert.equal(FONT_STYLES.length, 6);
  for (const style of FONT_STYLES) {
    const face = COMPOSE_FONT_FACES.find((item) => item.key === style.key);
    assert.ok(face, `missing webfont for ${style.key}`);
    assert.ok(face.family);
    assert.match(face.href, /^https:\/\//);
    assert.match(face.src, /family=/);
    assert.match(style.stack, new RegExp(face.family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const hand = FONT_STYLES.find((style) => style.key === "hand");
  assert.ok(hand);
  assert.match(hand.stack, /Iansui/);
  assert.doesNotMatch(hand.stack, /DFKai-SB|BiauKai/);
  const html = src("index.html");
  assert.match(html, /Iansui/);
  assert.match(html, /Noto\+Sans\+TC:wght@[^"']*900/);
  assert.match(html, /data-compose-fonts/);
  const overlay = src("src/features/visual-proposal/VisualProposalOverlay.tsx");
  assert.match(overlay, /ensureComposeFonts/);
});

test("現傳路徑與 testid 不變；圖庫入口加在＋素材旁", () => {
  const dock = src("src/features/visual-proposal/ProposalDock.tsx");
  const snapAt = dock.indexOf("const list = files ? Array.from(files)");
  const clearAt = dock.indexOf("materialRef.current.value = \"\"");
  assert.ok(snapAt >= 0 && clearAt > snapAt);
  assert.match(dock, /＋文字/);
  assert.match(dock, /色塊/);
  assert.match(dock, /data-testid="poster-add-asset"/);
  assert.match(dock, /data-testid="poster-add-asset-input"/);
  assert.match(dock, /data-testid="poster-save-version"/);
  assert.match(dock, /data-testid="poster-catalog-open"/);
  assert.match(dock, /prepareImageFile/);
  const helpers = src("src/features/visual-proposal/helpers.ts");
  assert.match(helpers, /file\.type === "image\/svg\+xml"/);
  const controls = src("src/features/visual-proposal/ProposalControls.tsx");
  assert.match(controls, /createImageItem/);
  assert.match(controls, /prepareImageFile/);
  assert.match(controls, /data-testid="poster-catalog-open"/);
  const quick = src("src/features/visual-proposal/ProposalQuickElement.tsx");
  const element = src("src/features/visual-proposal/ProposalElementControls.tsx");
  assert.match(quick, /FONT_STYLES\.map/);
  assert.match(element, /FONT_STYLES\.map/);
});

test("composeMaterials 排除紙底與當前版，素材庫與文宣去重且偏好庫名", () => {
  const posters = [
    { id: "v_a", label: "社徽", imageDataUrl: "data:image/png;base64,AAAAAAAAAAAA", kind: "image" as const },
    { id: "v_b", label: "場勘", imageDataUrl: "data:image/png;base64,BBBBBBBBBBBB", kind: "image" as const },
    { id: "v_c", label: "舊海報", imageDataUrl: "data:image/png;base64,CCCCCCCCCCCC", kind: "image" as const },
  ];
  const paper = {
    id: "v_paper",
    label: "紙底",
    filename: "紙底.png",
    imageDataUrl: "data:image/png;base64,PAPERPAPERPAPER",
    kind: "image" as const,
  };
  assert.equal(isComposePaperVersion(paper), true);
  assert.equal(isComposePaperVersion(posters[0]), false);
  const list = listComposeMaterials({
    versions: [...posters, paper],
    library: [{ id: "lib_1", title: "素材庫社徽", kind: "poster", linkedVersionId: "v_a" }],
    editingVersionId: "v_c",
  });
  assert.equal(list.some((item) => item.versionId === "v_paper"), false);
  assert.equal(list.some((item) => item.versionId === "v_c"), false);
  assert.equal(list.filter((item) => item.versionId === "v_a").length, 1);
  assert.equal(list.find((item) => item.versionId === "v_a")?.kind, "library");
  assert.equal(list.find((item) => item.versionId === "v_a")?.title, "素材庫社徽");
  assert.equal(list.find((item) => item.versionId === "v_a")?.sourceLabel, "素材庫");
  assert.equal(list.find((item) => item.versionId === "v_b")?.kind, "version");
  assert.equal(list.find((item) => item.versionId === "v_b")?.sourceLabel, "房間文宣");
  assert.equal(list.length, 2);
});

test("composeMaterials 看得到其他分支的文宣，不限當前 branch slice", () => {
  const list = listComposeMaterials({
    versions: [
      { id: "v_paper", label: "紙底", filename: "紙底.png", imageDataUrl: "data:image/png;base64,PAPERPAPERPAPER" },
      { id: "v_other", label: "演講文宣 · 初稿", imageDataUrl: "data:image/png;base64,POSTERPOSTER", kind: "image" },
    ],
    library: [],
    editingVersionId: "v_paper",
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].versionId, "v_other");
});

test("composeMaterials 排除影片版本與影片素材庫列", () => {
  const list = listComposeMaterials({
    versions: [
      { id: "v_img", label: "圖", imageDataUrl: "data:image/png;base64,AAAAAAAAAAAA", kind: "image" },
      { id: "v_vid", label: "片", imageDataUrl: "data:image/png;base64,BBBBBBBBBBBB", kind: "video" },
    ],
    library: [
      { id: "lib_vid", title: "影片庫", kind: "video", linkedVersionId: "v_vid" },
      { id: "lib_doc", title: "企劃", kind: "document", linkedVersionId: "v_img" },
    ],
    editingVersionId: "none",
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].versionId, "v_img");
});

test("placeComposeMaterial 只加 layer，拒絕非 data URL，不改 versions", () => {
  const versions = [{ id: "v_old", imageDataUrl: "data:image/png;base64,OLDOLDOLDOLD" }];
  const material = {
    id: "ver:v_a",
    title: "社徽",
    kind: "version" as const,
    versionId: "v_a",
    previewUrl: "",
    sourceLabel: "房間文宣",
  };
  const placed = placeComposeMaterial(emptyDoc(), material, "data:image/png;base64,NEWLAYERNEWLAYERNEW");
  assert.equal(placed.ok, true);
  if (placed.ok) {
    assert.equal(placed.item.type, "image");
    assert.match(placed.item.imageDataUrl, /^data:image\//);
    assert.equal(placed.doc.items.length, 1);
    assert.equal(placed.doc.versionId, "v_old");
  }
  assert.equal(versions[0].imageDataUrl, "data:image/png;base64,OLDOLDOLDOLD");
  const http = placeComposeMaterial(emptyDoc(), material, "https://example.invalid/poster.png");
  assert.equal(http.ok, false);
  if (!http.ok) assert.match(http.reason, /現傳/);
});

test("Dock / Controls 有房間素材與 picker，空畫布提示存在", () => {
  const dock = src("src/features/visual-proposal/ProposalDock.tsx");
  const controls = src("src/features/visual-proposal/ProposalControls.tsx");
  const overlay = src("src/features/visual-proposal/VisualProposalOverlay.tsx");
  const quick = src("src/features/visual-proposal/ProposalQuickElement.tsx");
  for (const file of [dock, controls]) {
    assert.match(file, /poster-pick-room-asset/);
    assert.match(file, /poster-compose-asset-picker/);
    assert.match(file, /ComposeAssetPicker/);
  }
  assert.match(overlay, /poster-compose-empty-hint/);
  assert.match(overlay, /把 logo、照片丟上來/);
  assert.match(overlay, /從房間撿/);
  assert.match(quick, /poster-layer-duplicate/);
  assert.match(quick, /poster-layer-forward/);
  assert.match(quick, /poster-layer-back/);
  assert.match(src("src/App.tsx"), /listLibraryAssets/);
  assert.match(src("src/App.tsx"), /resolveComposeMaterialDataUrl/);
  assert.doesNotMatch(src("src/features/visual-proposal/ProposalDock.tsx"), /getSupabase/);
  assert.doesNotMatch(src("src/features/multi-room/roomChrome.ts"), /FIRST_LAYER_TABS = \["對話", "白板",/);
});

test("純原稿隱藏 pin／svg.overlay／region-rect，工作層 overlay 仍在 ready 時畫", () => {
  const stage = src("src/features/image-review/Stage.tsx");
  const overlayAt = stage.indexOf("<VisualProposalOverlay");
  const gateAt = stage.indexOf("{annotationsVisible && (");
  const svgAt = stage.indexOf('<svg className="overlay"');
  const pinAt = stage.indexOf("{pins.map((pin) => {");
  const regionAt = stage.indexOf('className="region-rect"');
  assert.ok(overlayAt >= 0 && gateAt > overlayAt, "compose overlay must render before the annotations gate");
  assert.ok(svgAt > gateAt && pinAt > gateAt && regionAt > gateAt, "pin/svg/region must sit inside annotationsVisible");
});
