/**
 * Video temporal understanding.
 *
 * Produces bounded `asset_video_segments` from duration + optional transcript.
 * Keyframes stay derived stills; original video bytes are never rewritten.
 */

export type VideoSegmentDraft = {
  asset_id: string;
  start_seconds: number;
  end_seconds: number;
  summary: string;
  transcript: string;
  topics: string[];
  detected_text: string;
};

export type VideoUnderstandingInput = {
  assetId: string;
  title?: string;
  duration_seconds?: number;
  transcript?: string;
  keyframes?: Array<{ startSeconds?: number; endSeconds?: number; text?: string }>;
};

export class VideoUnderstandingProvider {
  understand(input: VideoUnderstandingInput): { segments: VideoSegmentDraft[]; duration_seconds: number } {
    const duration_seconds = Math.max(0, input.duration_seconds ?? 0);
    const keyframes = input.keyframes ?? [];
    if (keyframes.length) {
      return {
        duration_seconds,
        segments: keyframes.slice(0, 24).map((frame, index) => {
          const start = Math.max(0, frame.startSeconds ?? index * 5);
          const end = Math.max(start + 0.5, frame.endSeconds ?? start + 5);
          return {
            asset_id: input.assetId,
            start_seconds: start,
            end_seconds: duration_seconds > 0 ? Math.min(end, duration_seconds) : end,
            summary: (frame.text || input.title || `片段 ${index + 1}`).slice(0, 200),
            transcript: (input.transcript ?? "").slice(0, 4000),
            topics: [],
            detected_text: (frame.text ?? "").slice(0, 500),
          };
        }),
      };
    }
    if (duration_seconds <= 0) return { duration_seconds: 0, segments: [] };
    const window = duration_seconds <= 30 ? duration_seconds : Math.min(15, duration_seconds);
    const segments: VideoSegmentDraft[] = [];
    for (let start = 0, index = 0; start < duration_seconds && index < 24; start += window, index += 1) {
      const end = Math.min(duration_seconds, start + window);
      segments.push({
        asset_id: input.assetId,
        start_seconds: start,
        end_seconds: end,
        summary: index === 0 ? (input.title || "開場") : `片段 ${index + 1}`,
        transcript: (input.transcript ?? "").slice(0, 4000),
        topics: [],
        detected_text: "",
      });
    }
    return { duration_seconds, segments };
  }
}
