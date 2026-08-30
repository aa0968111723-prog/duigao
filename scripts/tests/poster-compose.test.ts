import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { branchOpenCommentCount, normalizeRoomBranches } from "../../src/lib/roomBranches.ts";
import type { Room, RoomBranch } from "../../src/lib/types.ts";
import type { VisualProposal } from "../../src/features/visual-proposal/store.ts";
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

test("畫布與存檔走既有 testid，不改第一層 IA", () => {
  const overlay = src("src/features/visual-proposal/VisualProposalOverlay.tsx");
  const stage = src("src/features/image-review/Stage.tsx");
  const chrome = src("src/features/multi-room/roomChrome.ts");
  assert.match(overlay, /data-testid="poster-compose-canvas"/);
  assert.match(stage, /data-testid="poster-compose-stage"/);
  assert.match(chrome, /FIRST_LAYER_TABS = \["對話", "白板"\]/);
  assert.match(chrome, /FIRST_LAYER_TOP = \["back", "title", "presence", "voice", "more"\]/);
});
