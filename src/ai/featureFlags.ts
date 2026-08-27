/**
 * Collaborative Intelligence Workspace 1.0 — feature flags.
 *
 * Unfinished phases stay off. A flag that is false must not grow a fake UI
 * entry; the mobile shell keeps showing the existing room, not 白板 / 語音 /
 * Canva placeholders.
 */
export const FEATURE_FLAGS = {
  "ai.assetIntelligence": true,
  "collaboration.discussion": false,
  "collaboration.whiteboard": false,
  "collaboration.voice": false,
  "canva.integration": false,
} as const;

export type FeatureFlagId = keyof typeof FEATURE_FLAGS;
export type FeatureFlagState = "enabled" | "disabled";

export function featureFlagState(id: FeatureFlagId): FeatureFlagState {
  return FEATURE_FLAGS[id] ? "enabled" : "disabled";
}

export function isFeatureEnabled(id: FeatureFlagId): boolean {
  return FEATURE_FLAGS[id] === true;
}

/** Optional phases must be reported as disabled, never as implemented. */
export function optionalPhaseMap(): Record<"canva.integration" | "collaboration.voice", "DISABLED"> {
  return {
    "canva.integration": "DISABLED",
    "collaboration.voice": "DISABLED",
  };
}
