import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyStorageUploadError,
  encodeTusMetadata,
  TUS_CHUNK_BYTES,
  tusFingerprint,
  uploadResumableVideo,
} from "../../src/cloud/tusUpload";
import { classifyOptimizeNeed, planVideoTranscode, shouldOptimizeVideo, targetBitrate } from "../../src/cloud/videoOptimize";
import { insertLibraryAsset, libraryAssetFromRow } from "../../src/cloud/assetLibrary";

test("tus fingerprint is stable per object and file identity", () => {
  const left = tusFingerprint({
    origin: "https://proj.supabase.co",
    objectName: "rooms/r1/videos/v1/original.mp4",
    fileName: "cut.mp4",
    fileSize: 80,
    lastModified: 10,
  });
  const right = tusFingerprint({
    origin: "https://proj.supabase.co",
    objectName: "rooms/r1/videos/v1/original.mp4",
    fileName: "cut.mp4",
    fileSize: 80,
    lastModified: 10,
  });
  const otherRoom = tusFingerprint({
    origin: "https://proj.supabase.co",
    objectName: "rooms/r2/videos/v1/original.mp4",
    fileName: "cut.mp4",
    fileSize: 80,
    lastModified: 10,
  });
  assert.equal(left, right);
  assert.notEqual(left, otherRoom);
  assert.match(left, /room-assets/);
});

test("tus metadata and 6MB chunk contract", () => {
  const header = encodeTusMetadata({ bucketName: "room-assets", objectName: "rooms/a/videos/b/original.mp4" });
  assert.match(header, /bucketName /);
  assert.match(header, /objectName /);
  assert.equal(TUS_CHUNK_BYTES, 6 * 1024 * 1024);
});

test("storage errors are classified without leaking backend text", () => {
  assert.match(classifyStorageUploadError(413, "Payload too large").message, /大小/);
  assert.match(classifyStorageUploadError(403, "row-level security").message, /權限/);
  assert.match(classifyStorageUploadError(0, "").message, /網路中斷/);
  assert.match(classifyStorageUploadError(400, "unsupported codec").message, /最佳化/);
  assert.doesNotMatch(classifyStorageUploadError(400, "internal boom jwt raw").message, /boom/);
});

test("resumable upload pause/resume continues from offset, not zero", async () => {
  const file = new Blob([new Uint8Array(TUS_CHUNK_BYTES + 12)]);
  let stored = new Uint8Array(0);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (method === "POST" && url.includes("/upload/resumable") && !url.includes("up_1")) {
      return new Response(null, { status: 201, headers: { location: "http://tus.test/storage/v1/upload/resumable/up_1" } });
    }
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { "upload-offset": String(stored.length) } });
    }
    if (method === "PATCH") {
      const body = init?.body as Blob;
      const next = new Uint8Array(stored.length + body.size);
      next.set(stored, 0);
      next.set(new Uint8Array(await body.arrayBuffer()), stored.length);
      stored = next;
      return new Response(null, { status: 204, headers: { "upload-offset": String(stored.length) } });
    }
    return new Response("no", { status: 404 });
  };

  const handle = uploadResumableVideo({
    path: "rooms/r/videos/v/original.bin",
    file,
    mime: "application/octet-stream",
    accessToken: "tok",
    onProgress: () => undefined,
    fetchImpl,
    supabaseUrl: "http://tus.test",
    apiKey: "key",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  handle.pause();
  handle.resume();
  const path = await handle.done;
  assert.equal(path, "rooms/r/videos/v/original.bin");
  assert.equal(stored.length, file.size);
});

test("transcode plan: small mp4 is direct, large or mov is optimized", () => {
  assert.equal(planVideoTranscode({ size: 12 * 1024 * 1024, mime: "video/mp4" }), "direct");
  assert.equal(shouldOptimizeVideo({ size: 12 * 1024 * 1024, mime: "video/mp4" }), false);
  assert.equal(shouldOptimizeVideo({ size: 55 * 1024 * 1024, mime: "video/mp4" }), true);
  assert.equal(planVideoTranscode({ size: 70 * 1024 * 1024, mime: "video/mp4" }), "browser-optimize");
  assert.equal(planVideoTranscode({ size: 8 * 1024 * 1024, mime: "video/quicktime", name: "clip.mov" }), "browser-optimize");
  assert.match(classifyOptimizeNeed(new File([new Uint8Array(8)], "a.mp4", { type: "video/mp4" })).message, /直接上傳/);
  assert.ok(targetBitrate(60) > 400_000);
});

test("library_assets row mapping keeps room scope", () => {
  const asset = libraryAssetFromRow({
    id: "lib-1",
    scope: "room",
    room_id: "room-1",
    title: "茶會文宣",
    filename: "poster.png",
    summary: "春季",
    topics: ["茶會"],
    kind: "poster",
    linked_asset_id: null,
    linked_version_id: "ver-1",
    created_by: "user-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(asset.scope, "room");
  assert.equal(asset.linkedVersionId, "ver-1");
  assert.equal(typeof insertLibraryAsset, "function");
});
