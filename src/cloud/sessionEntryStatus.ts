/**
 * Guest / empty-room honesty for the App onboard (ported onto main remainders).
 *
 * Does not invent a second room shell. Project rooms already enter
 * MultiBranchRoom with zero versions. This helper only classifies the
 * leftover !hasVersions guest card so it cannot stay on「正在載入…」
 * after the cloud is synced, or treat RLS denial as a flaky retry.
 */
import type { SyncStatus } from "./types";

export type SessionEntryKind =
  | "auth-loading"
  | "room-loading"
  | "empty-room"
  | "permission-denied"
  | "invite-invalid"
  | "legacy-stalled"
  | "load-error"
  | "ready";

export type SessionEntryRetry = "cloud" | "legacy" | "none";

export type SessionEntryStatus = {
  kind: SessionEntryKind;
  headline: string;
  note: string | null;
  retry: SessionEntryRetry;
};

export function sessionEntryStatus(input: {
  isCloudGuest: boolean;
  isLegacyLink: boolean;
  cloudStatus: SyncStatus;
  collabStatus: string | null;
  inviteInvalid: boolean;
  permissionDenied: boolean;
  hasVersions: boolean;
  projectMode: boolean;
}): SessionEntryStatus {
  if (input.hasVersions || input.projectMode) {
    return { kind: "ready", headline: "", note: null, retry: "none" };
  }

  if (input.permissionDenied) {
    return {
      kind: "permission-denied",
      headline: "沒有權限進入這個房間",
      note: "這個帳號讀不到房間內容。請向主辦方確認分享連結，或改用對方寄出的新連結。",
      retry: "none",
    };
  }

  if (input.inviteInvalid) {
    return {
      kind: "invite-invalid",
      headline: "分享連結無效或已失效",
      note: "請向分享的人要一個新的連結。",
      retry: "none",
    };
  }

  const peerStalled = input.collabStatus === "waiting" || input.collabStatus === "error";
  if (input.isLegacyLink && peerStalled) {
    return {
      kind: "legacy-stalled",
      headline: "這是舊版分享連結",
      note: "舊版連結需要主辦方保持頁面開著才打得開。請向主辦方取得新版分享連結，新版連結在主辦方關掉頁面後也能打開。",
      retry: "legacy",
    };
  }

  if (input.isCloudGuest) {
    if (input.cloudStatus === "connecting") {
      return {
        kind: "auth-loading",
        headline: "正在確認身分並進入房間…",
        note: null,
        retry: "none",
      };
    }
    if (input.cloudStatus === "syncing") {
      return {
        kind: "room-loading",
        headline: "正在載入房間…",
        note: null,
        retry: "none",
      };
    }
    if (input.cloudStatus === "error") {
      return {
        kind: "load-error",
        headline: "目前暫時無法載入這個討論，請稍後再試。",
        note: "可能是網路不太穩，會自動重試；稍後再打開這個連結也可以。",
        retry: "cloud",
      };
    }
    if (
      input.cloudStatus === "synced" ||
      input.cloudStatus === "offline-pending" ||
      input.cloudStatus === "local-only"
    ) {
      return {
        kind: "empty-room",
        headline: "這個房間還沒有文宣或影片",
        note: "房間已打開，只是還沒有版本。不是載入失敗。",
        retry: "none",
      };
    }
  }

  if (peerStalled) {
    return {
      kind: "load-error",
      headline: "目前暫時無法載入這個討論，請稍後再試。",
      note: "可能是網路不太穩，會自動重試；稍後再打開這個連結也可以。",
      retry: "legacy",
    };
  }

  return {
    kind: "room-loading",
    headline: "正在載入房間…",
    note: null,
    retry: "none",
  };
}
