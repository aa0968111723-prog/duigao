/**
 * Home / first-work surface honesty (PR-GAP-01).
 *
 * Does not pretend a room exists, a share link was created, or the cloud is
 * up. Used by Home only — App.tsx onboard stays owned by open PRs.
 */

export type HomeEntryKind = "ok" | "offline" | "service-not-configured";

export type HomeEntryStatus = {
  kind: HomeEntryKind;
  message: string | null;
};

export function homeEntryStatus(input: {
  online: boolean;
  cloudConfigured: boolean;
  productionBuild: boolean;
}): HomeEntryStatus {
  if (!input.online) {
    return {
      kind: "offline",
      message: "目前離線。看過的房間還在這台裝置，但不能建立新的雲端房。",
    };
  }
  if (input.productionBuild && !input.cloudConfigured) {
    return {
      kind: "service-not-configured",
      message: "雲端服務尚未設定。無法建立永久分享連結。",
    };
  }
  return { kind: "ok", message: null };
}
