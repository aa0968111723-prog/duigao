import type { SupabaseClient } from "@supabase/supabase-js";
import { CloudError } from "./errors";

/**
 * Mounted client for `library_assets`.
 *
 * Reviewers can read a room library; only owner/editor (can_manage_media) may
 * write. Shared-scope rows stay author-owned via 0017. This module never
 * uploads original media — it only links an already-stored version.
 */

export type LibraryAssetKind = "image" | "poster" | "video" | "document" | "audio";
export type LibraryAssetScope = "shared" | "room";

export type LibraryAsset = {
  id: string;
  scope: LibraryAssetScope;
  roomId?: string;
  title: string;
  filename?: string;
  summary: string;
  topics: string[];
  kind: LibraryAssetKind;
  linkedAssetId?: string;
  linkedVersionId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type LibraryAssetInput = {
  scope?: LibraryAssetScope;
  roomId?: string;
  title: string;
  filename?: string;
  summary?: string;
  topics?: string[];
  kind: LibraryAssetKind;
  linkedAssetId?: string;
  linkedVersionId?: string;
};

type LibraryRow = {
  id: string;
  scope: LibraryAssetScope;
  room_id: string | null;
  title: string;
  filename: string | null;
  summary: string;
  topics: string[] | null;
  kind: LibraryAssetKind;
  linked_asset_id: string | null;
  linked_version_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export function libraryAssetFromRow(row: LibraryRow): LibraryAsset {
  return {
    id: row.id,
    scope: row.scope,
    roomId: row.room_id ?? undefined,
    title: row.title,
    filename: row.filename ?? undefined,
    summary: row.summary ?? "",
    topics: row.topics ?? [],
    kind: row.kind,
    linkedAssetId: row.linked_asset_id ?? undefined,
    linkedVersionId: row.linked_version_id ?? undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertLibraryAsset(supabase: SupabaseClient, input: LibraryAssetInput): Promise<LibraryAsset> {
  const scope = input.scope ?? (input.roomId ? "room" : "shared");
  const { data, error } = await supabase
    .from("library_assets")
    .insert({
      scope,
      room_id: scope === "room" ? input.roomId ?? null : null,
      title: input.title.trim(),
      filename: input.filename ?? null,
      summary: (input.summary ?? "").trim(),
      topics: input.topics ?? [],
      kind: input.kind,
      linked_asset_id: input.linkedAssetId ?? null,
      linked_version_id: input.linkedVersionId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new CloudError(error?.message ?? "素材庫寫入失敗", "write");
  return libraryAssetFromRow(data as LibraryRow);
}

export async function listLibraryAssets(supabase: SupabaseClient, roomId?: string): Promise<LibraryAsset[]> {
  let query = supabase.from("library_assets").select("*").order("updated_at", { ascending: false });
  if (roomId) query = query.or(`scope.eq.shared,room_id.eq.${roomId}`);
  const { data, error } = await query;
  if (error) throw new CloudError(error.message, "load");
  return ((data as LibraryRow[] | null) ?? []).map(libraryAssetFromRow);
}

export async function removeLibraryAsset(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from("library_assets").delete().eq("id", id);
  if (error) throw new CloudError(error.message, "write");
}
