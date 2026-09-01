import { useSyncExternalStore } from "react";
import type { OpenStudioDetail, StudioExportPayload, StudioKind } from "../../lib/studioEmbed";

export type StudioSession = {
  open: boolean;
  kind: StudioKind;
  name: string;
  width: number;
  height: number;
  embed: boolean;
  onExport?: (file: File, payload: StudioExportPayload) => void;
  onCancel?: () => void;
};

const CLOSED: StudioSession = {
  open: false,
  kind: "poster",
  name: "",
  width: 1080,
  height: 1350,
  embed: false,
};

let session: StudioSession = CLOSED;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openNativeStudio(detail: OpenStudioDetail): void {
  const kind: StudioKind = detail.kind === "video" ? "video" : "poster";
  session = {
    open: true,
    kind,
    name: detail.name || (kind === "video" ? "未命名影片" : "未命名海報"),
    width: detail.width || (kind === "video" ? 1920 : 1080),
    height: detail.height || (kind === "video" ? 1080 : 1350),
    embed: Boolean(detail.embed),
    onExport: detail.onExport,
    onCancel: detail.onCancel,
  };
  emit();
}

export function closeNativeStudio(): void {
  session = { ...CLOSED };
  emit();
}

export function getStudio(): StudioSession {
  return session;
}

export function subscribeStudio(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStudio(): StudioSession {
  return useSyncExternalStore(subscribeStudio, getStudio, getStudio);
}
