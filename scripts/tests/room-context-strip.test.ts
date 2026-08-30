import assert from "node:assert/strict";
import test from "node:test";
import { stripSecrets } from "../../supabase/functions/_shared/roomContext.ts";
import { buildRoomAgentCard, roomAgentCardLeaks } from "../../src/ai/roomAgentContract.ts";

test("stripSecrets drops storage path keys that 0015 puts in asset metadata", () => {
  const cleaned = stripSecrets({
    title: "招生文宣",
    summary: "擺攤主視覺",
    storage_path: "rooms/abc/versions/v1/poster.png",
    poster_storage_path: "rooms/abc/versions/v1/poster.png",
    image_path: "rooms/abc/versions/v1/poster.png",
    video_path: "rooms/abc/videos/v1/original.mp4",
    nested: {
      imagePath: "secret.png",
      headline: "茶會",
    },
    invite_token: "should-never-leave",
  });
  assert.equal(cleaned.title, "招生文宣");
  assert.equal(cleaned.summary, "擺攤主視覺");
  assert.equal(cleaned.nested.headline, "茶會");
  assert.equal("storage_path" in cleaned, false);
  assert.equal("poster_storage_path" in cleaned, false);
  assert.equal("image_path" in cleaned, false);
  assert.equal("video_path" in cleaned, false);
  assert.equal("imagePath" in cleaned.nested, false);
  assert.equal("invite_token" in cleaned, false);
});

test("buildRoomAgentCard never ships invite / data URL / service role / full storage path", () => {
  const card = buildRoomAgentCard({
    room: { id: "r1", title: "房", role: "reviewer" },
    contents: [{ branchId: "b1", type: "poster", name: "海報", latestVersionLabel: "改一", openCommentCount: 1 }],
    focus: {
      label: "海報",
      thumbnailPath: "rooms/r1/versions/v1/poster.png",
      thumbnailDescription: "主視覺直式",
    },
    workLayer: {
      proposalId: "p1",
      status: "draft",
      items: [{ id: "i1", type: "image", imageDataUrl: "data:image/png;base64,QQ==" }],
    },
  });
  assert.deepEqual(roomAgentCardLeaks(card), []);
  assert.equal(card.focus?.thumbnail?.kind, "description");
  assert.equal(JSON.stringify(card).includes("imageDataUrl"), false);
});
