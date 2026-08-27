import { extractTopics, rankPhotosForUse } from "../ai/understanding";

export type LibraryScope = "shared" | "room";

export type LibraryAsset = {
  id: string;
  scope: LibraryScope;
  roomId?: string;
  title: string;
  filename?: string;
  summary: string;
  topics: string[];
  kind: "image" | "poster" | "video" | "document" | "audio";
  linkedAssetId?: string;
  linkedVersionId?: string;
};

export function searchLibrary(items: LibraryAsset[], query: string): Array<LibraryAsset & { score: number; reason: string }> {
  const ranked = rankPhotosForUse(
    items.map((item) => ({
      id: item.id,
      title: item.title,
      filename: item.filename,
      topics: item.topics.length ? item.topics : extractTopics(`${item.title}\n${item.summary}`),
      summary: item.summary,
    })),
    query,
  );
  return ranked.map((row) => {
    const item = items.find((entry) => entry.id === row.id);
    if (!item) throw new Error(`library rank returned unknown id ${row.id}`);
    return { ...item, score: row.score, reason: row.reason };
  });
}

export function sharedDefaults(): LibraryAsset[] {
  return [
    { id: "lib_logo", scope: "shared", title: "社團 Logo", summary: "淡江禪學社固定標誌", topics: ["主視覺"], kind: "image" },
    { id: "lib_qr", scope: "shared", title: "報名 QR", summary: "固定報名表單 QR", topics: ["QR／報名"], kind: "image" },
  ];
}
