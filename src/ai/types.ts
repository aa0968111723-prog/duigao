import type { BranchType } from "../lib/types";

export type AssetKind = "poster" | "video" | "plan" | "copy" | "image" | "document" | "audio";

export type AnalysisSource = "structured" | "vision" | "transcript" | "manual";
export type AnalysisStatus = "pending" | "ready" | "failed";
export type AnalysisKind = "image" | "document" | "audio" | "video";

export type AssetRelationType = "related" | "variant_of" | "used_in" | "derived_from";

export type KnowledgeKind =
  | "asset_summary"
  | "image_analysis"
  | "document"
  | "video_segment"
  | "relation"
  | "comment"
  | "whiteboard_node"
  | "whiteboard_edge";

export type RoomContextIntent =
  | "poster_summary"
  | "video_at_time"
  | "photo_fit"
  | "plan_gaps"
  | "version_compare"
  | "asset_search"
  | "board_summary"
  | "general";

export type AssetRecord = {
  id: string;
  roomId: string;
  branchId: string;
  branchType: BranchType;
  kind: AssetKind;
  title: string;
  /** Reference to an existing version. Never a copy of original bytes. */
  sourceVersionId?: string;
  currentVersionId?: string;
};

export type AssetAnalysis = {
  id: string;
  assetId: string;
  versionId?: string;
  kind: AnalysisKind;
  status: AnalysisStatus;
  source: AnalysisSource;
  summary: string;
  topics: string[];
  ocrText?: string;
  caption?: string;
  payload?: Record<string, unknown>;
};

export type AssetVideoSegment = {
  id: string;
  assetId: string;
  versionId: string;
  startSeconds: number;
  endSeconds: number;
  summary: string;
  topics: string[];
  source: "comment" | "transcript" | "manual" | "analysis";
};

export type AssetRelation = {
  id: string;
  roomId: string;
  fromAssetId: string;
  toAssetId: string;
  relationType: AssetRelationType;
};

export type KnowledgeEntry = {
  id: string;
  roomId: string;
  assetId?: string;
  versionId?: string;
  branchId?: string;
  segmentId?: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  topics: string[];
  isCurrentVersion: boolean;
};

export type RoomContextItem = {
  kind: KnowledgeKind | "version" | "plan_gap" | "ranked_photo";
  title: string;
  body: string;
  topics: string[];
  assetId?: string;
  versionId?: string;
  versionLabel?: string;
  branchId?: string;
  startSeconds?: number;
  endSeconds?: number;
  score: number;
  isCurrentVersion?: boolean;
  nodeId?: string;
  nodeType?: string;
  fromNodeId?: string;
  toNodeId?: string;
};

export type RoomContextQuery = {
  text: string;
  roomId?: string;
  timeSeconds?: number;
  compareVersionIds?: string[];
  compareLabels?: string[];
  selectedAssetIds?: string[];
  selectedNodeIds?: string[];
  limit?: number;
};

export type RoomContext = {
  roomId: string;
  query: string;
  intent: RoomContextIntent;
  timeSeconds?: number;
  /** True: only a retrieved slice. The whole room is never in the prompt. */
  truncated: true;
  fullRoomDumped: false;
  currentVersionOnly: boolean;
  items: RoomContextItem[];
};

/** Matches tku-zen-agent `DuigaoAsset` / `DuigaoContextRequest`. Extra fields are ignored there. */
export type ZenAgentAsset = {
  sourceId: string;
  assetId: string;
  title: string;
  assetType: string;
  branchId?: string;
  versionId?: string;
  versionLabel?: string;
  isCurrent: boolean;
  archived: boolean;
  summary?: string;
  detectedText?: string;
  topics: string[];
  keywords: string[];
  segments?: Array<{ startSeconds: number; endSeconds: number; summary: string; topics: string[] }>;
};

export type ZenAgentSource = {
  sourceId: string;
  assetId?: string;
  title: string;
  assetType?: string;
  versionId?: string;
  versionLabel?: string;
  excerpt?: string;
};

export type ZenAgentRoomRequest = {
  agent: "tku-zen-agent";
  source: "duigao.room-context";
  notASecondAgent: true;
  query: string;
  context: ZenAgentAsset[];
  sources: ZenAgentSource[];
  relations: Array<{ sourceId: string; targetId: string; relationType: string }>;
};
