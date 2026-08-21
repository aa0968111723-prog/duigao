import { memo, useCallback, useEffect, useRef } from "react";
import type { CommentPin } from "../../lib/types";
import { formatTime } from "./media";

/**
 * The timeline: where the video's feedback lives.
 *
 * Performance contract (spec §16): the playhead moves sixty times a second and
 * must never cost a React render. The parent hands us a `subscribe` function;
 * we register once, and every frame writes a CSS transform on one element. The
 * markers — which only change when the discussion changes — are a memoized
 * child, so a playing video re-renders nothing at all.
 */

export type TimelineMarker = {
  id: string;
  number: number;
  start: number;
  /** Present for a range; the bar is drawn from start to end. */
  end?: number;
  resolved: boolean;
  color: string;
};

/**
 * A pile of 一鍵反應 at roughly the same moment, drawn as ONE marker.
 *
 * Six people tapping ⚡ at 00:21 is one fact about the cut, not six dots the
 * author has to visually merge. Clustering happens before this component so the
 * timeline only ever renders what it should show.
 */
export type ReactionCluster = {
  id: string;
  time: number;
  emoji: string;
  count: number;
  label: string;
};

type Props = {
  duration: number;
  /** Registers a per-frame playhead listener. Returns an unsubscribe. */
  subscribe: (listener: (seconds: number) => void) => () => void;
  markers: TimelineMarker[];
  reactions?: ReactionCluster[];
  selectedId: string | null;
  onSeek: (seconds: number) => void;
  onSelectMarker: (id: string) => void;
  /** While picking a range: the confirmed start, and the live end. */
  selection?: { start: number; end: number | null } | null;
};

const clampFraction = (value: number): number => Math.max(0, Math.min(1, value));

export function VideoTimeline({
  duration,
  subscribe,
  markers,
  reactions,
  selectedId,
  onSeek,
  onSelectMarker,
  selection,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  // One subscription for the life of the component. The listener touches the
  // DOM directly — no state, no reconciliation, no re-render.
  useEffect(() => {
    let announced = -1;
    const paint = (seconds: number) => {
      if (scrubbing.current) return; // the finger wins while it is down
      const fraction = duration > 0 ? clampFraction(seconds / duration) : 0;
      const pct = `${fraction * 100}%`;
      if (headRef.current) headRef.current.style.left = pct;
      if (progressRef.current) progressRef.current.style.width = pct;
      // The slider's announced position has to be the real one, but it is not
      // worth a render — so it is written here, on the same DOM-only path, and
      // only when the whole second actually changes.
      const whole = Math.max(0, Math.round(seconds));
      if (whole !== announced && trackRef.current) {
        announced = whole;
        trackRef.current.setAttribute("aria-valuenow", String(whole));
        trackRef.current.setAttribute(
          "aria-valuetext",
          duration > 0
            ? `${formatTime(seconds)}，全長 ${formatTime(duration)}`
            : `${formatTime(seconds)}，長度未知`,
        );
      }
    };
    return subscribe(paint);
  }, [subscribe, duration]);

  const timeAt = useCallback(
    (clientX: number): number => {
      const box = trackRef.current?.getBoundingClientRect();
      if (!box || box.width === 0 || duration <= 0) return 0;
      return clampFraction((clientX - box.left) / box.width) * duration;
    },
    [duration],
  );

  /**
   * Scrubbing is pointer-captured so a finger that slides off the thin track
   * keeps seeking instead of dropping the gesture — and so a tap on a marker
   * (a real button above the track) is never swallowed by the track itself.
   */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    scrubbing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = timeAt(e.clientX);
    paintNow(t);
    onSeek(t);
  };

  const paintNow = (seconds: number) => {
    const fraction = duration > 0 ? clampFraction(seconds / duration) : 0;
    const pct = `${fraction * 100}%`;
    if (headRef.current) headRef.current.style.left = pct;
    if (progressRef.current) progressRef.current.style.width = pct;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) return;
    const t = timeAt(e.clientX);
    paintNow(t);
    onSeek(t);
  };

  const endScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already gone */
    }
  };

  return (
    <div className="v-timeline" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endScrub} onPointerCancel={endScrub}>
      <div
        ref={trackRef}
        className="v-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        role="slider"
        tabIndex={0}
        aria-label="影片時間軸"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, Math.round(duration))}
        // Initial values only; the paint callback keeps them current without
        // dragging the playhead through React.
        aria-valuenow={0}
        aria-valuetext={duration > 0 ? `0:00，全長 ${formatTime(duration)}` : "0:00，長度未知"}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const box = headRef.current;
            const current = box ? (parseFloat(box.style.left) / 100) * duration : 0;
            onSeek(Math.max(0, Math.min(current + (e.key === "ArrowRight" ? 5 : -5), duration)));
          }
        }}
      >
        <div ref={progressRef} className="v-track-played" />

        {selection && duration > 0 && (
          <div
            className="v-range-live"
            style={{
              left: `${clampFraction(selection.start / duration) * 100}%`,
              width: `${
                clampFraction(((selection.end ?? selection.start) - selection.start) / duration) * 100
              }%`,
            }}
            aria-hidden
          />
        )}

        <Markers
          markers={markers}
          duration={duration}
          selectedId={selectedId}
          onSelectMarker={onSelectMarker}
        />

        <ReactionMarks clusters={reactions ?? []} duration={duration} onSeek={onSeek} />

        <div ref={headRef} className="v-playhead" aria-hidden />
      </div>
    </div>
  );
}

/**
 * Reaction clusters, under the feedback markers and deliberately quieter: they
 * are ambient signal, not items on a to-do list. Tapping one seeks there.
 */
const ReactionMarks = memo(function ReactionMarks({
  clusters,
  duration,
  onSeek,
}: {
  clusters: ReactionCluster[];
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  if (duration <= 0 || clusters.length === 0) return null;
  return (
    <>
      {clusters.map((c) => (
        <button
          key={c.id}
          type="button"
          className="v-rmark"
          style={{ ["--marker-left" as string]: `${clampFraction(c.time / duration) * 100}%` }}
          aria-label={c.label}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onSeek(c.time);
          }}
        >
          <span aria-hidden>{c.emoji}</span>
          {c.count > 1 && <b aria-hidden>{c.count}</b>}
        </button>
      ))}
    </>
  );
});

/**
 * Markers re-render only when the discussion changes. They sit above the track
 * as real buttons: a screen reader hears "修改點 3，00:13", and a thumb gets a
 * 32px target even though the dot is 10px.
 */
const Markers = memo(function Markers({
  markers,
  duration,
  selectedId,
  onSelectMarker,
}: {
  markers: TimelineMarker[];
  duration: number;
  selectedId: string | null;
  onSelectMarker: (id: string) => void;
}) {
  if (duration <= 0) return null;
  return (
    <>
      {markers.map((m) => {
        // Clamp the two ENDS, then measure between them. Clamping the width
        // separately lets a range whose end outlives a shorter cut draw past
        // the track — which happens the moment someone switches versions.
        const startFraction = clampFraction(m.start / duration);
        const isRange = typeof m.end === "number" && m.end > m.start;
        const endFraction = isRange ? clampFraction(m.end! / duration) : startFraction;
        const left = startFraction * 100;
        const width = Math.max(0, endFraction - startFraction) * 100;
        const label = isRange
          ? `修改點 ${m.number}，${formatTime(m.start)} 到 ${formatTime(m.end!)}`
          : `修改點 ${m.number}，${formatTime(m.start)}`;
        return (
          <button
            key={m.id}
            type="button"
            className={[
              "v-marker",
              isRange ? "v-marker-range" : "v-marker-point",
              m.resolved ? "is-done" : "",
              m.id === selectedId ? "is-selected" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              // Fed through --marker-left so the stylesheet can clamp it and
              // keep a 0:00 marker's tap target inside the viewport.
              ["--marker-left" as string]: `${left}%`,
              ...(isRange ? { width: `${Math.max(width, 1.5)}%` } : {}),
              ["--marker" as string]: m.color,
            }}
            aria-label={label}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSelectMarker(m.id);
            }}
          >
            <span className="v-marker-no">{m.number}</span>
          </button>
        );
      })}
    </>
  );
});
