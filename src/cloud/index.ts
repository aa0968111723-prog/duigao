export {
  cloudConfigIssues,
  cloudConfigStatus,
  isCloudConfigured,
  isCloudDeploymentBroken,
  isProductionBuild,
  type CloudConfigStatus,
} from "./config";
export { getSupabase } from "./client";
export { ensureSession } from "./auth";
export { CloudError, isInvalidInvite, isPermissionDenied, isRevisionConflict } from "./errors";
export {
  addRoomTarget,
  buildInviteUrl,
  generateInviteToken,
  newRoomId,
  readInviteFromUrl,
  readRoomLink,
  replaceUrlWithInvite,
  roomLinkIdentity,
  type RoomLink,
  type RoomTarget,
  type UrlInvite,
} from "./invite";
export { upgradeLegacyShareUrl } from "./legacy";
export { getCloudMapping, saveCloudMapping, type CloudMapping } from "./mapping";
export { signedUrl } from "./assets";
export {
  addVersion,
  createRoom,
  deleteStroke,
  insertComment,
  insertMessage,
  insertStroke,
  joinRoom,
  loadRoom,
  setCommentResolved,
  setRoomTitle,
  upsertProposal,
  type CloudProposal,
  type CloudSnapshot,
} from "./roomRepository";
export {
  buildPreviewShareUrl,
  ensureRoomPreview,
  loadRoomPreview,
  previewThumbnailUrl,
  renderShareThumbnail,
  rotateRoomPreview,
  IMAGE_SHARE_DESCRIPTION,
  VIDEO_SHARE_DESCRIPTION,
  PREVIEW_BUCKET,
  type CoverSource,
  type SharePreview,
  type SharePreviewPatch,
} from "./sharePreview";
export { subscribeRoom, type SyncHandlers, type Unsubscribe } from "./roomSync";
export { roomLiveSyncClaim, roomPresenceLabel, realtimeSubscribeIsJoined } from "./realtimeHonesty";
export { syncStatusLabel, type SyncStatus } from "./types";
export { useCloudRoom, type PreviewOpts, type ShareResult, type SharePreviewApi } from "./useCloudRoom";
export { signedUrl as cloudSignedUrl } from "./assets";
