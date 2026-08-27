import { isFeatureEnabled } from "../ai/featureFlags";

export type DiscussionTabId = "chat" | "board" | "voice";

export type DiscussionTab = {
  id: DiscussionTabId;
  label: string;
  enabled: boolean;
};

/** First-screen chrome. Hidden tools stay in contextual + / ✦ only. */
export const HIDDEN_FIRST_SCREEN = ["AI", "Flow", "Mindmap", "Canva", "Assets", "Poll", "Diagram", "Tools", "Nodes"] as const;

export function discussionTabs(): DiscussionTab[] {
  return [
    { id: "chat", label: "對話", enabled: isFeatureEnabled("collaboration.discussion") },
    { id: "board", label: "白板", enabled: isFeatureEnabled("collaboration.whiteboard") },
    { id: "voice", label: "語音", enabled: isFeatureEnabled("collaboration.voice") },
  ];
}

export function firstScreenLabels(): string[] {
  return discussionTabs().map((tab) => tab.label);
}

export function plusMenuItems(): string[] {
  return ["便利貼", "流程", "心智圖", "房間內容", "素材"];
}

export function voiceIsWorkingRoom(): boolean {
  return isFeatureEnabled("collaboration.voice");
}
