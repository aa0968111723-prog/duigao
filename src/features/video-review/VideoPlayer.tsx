import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { formatTime } from "./media";

/**
 * The player.
 *
 * Two rules shape this file:
 *
 *   1. **The video is the screen.** Controls are a thin strip under it; nothing
 *      shrinks the picture to make room for a tool.
 *   2. **`currentTime` never goes through React on every frame.** A video fires
 *      timeupdate several times a second and rAF sixty times a second; pushing
 *      that into state would re-render the discussion list with it. Instead the
 *      playhead is written straight to the DOM through a subscriber callback,
 *      and React state is updated at a human rate (4×/s) for the clock readout.
 */

export type PlayerHandle = {
  /** Jump to a time. `play` lets a discussion tap start playback from there. */
  seek: (seconds: number, opts?: { play?: boolean }) => void;
  pause: () => void;
  /** The live time, without waiting for a render. Used when a comment is filed. */
  currentTime: () => number;
  duration: () => number;
  isPaused: () => boolean;
};

type Props = {
  src: string;
  /**
   * Stable identity of the video: its storage path.
   *
   * `src` is a signed URL that is re-minted every time the room reloads, and a
   * room reloads on every realtime event. Keying playback on the URL would
   * reload the video — and reset it to 0:00 — each time somebody else posted a
   * comment. The path only changes when the video genuinely changes.
   */
  srcKey: string;
  poster?: string;
  /** Declared type of the file, used to explain a codec the browser refuses. */
  mimeType?: string;
  /** Known from the version row; lets the timeline exist before metadata loads. */
  knownDuration?: number;
  /**
   * Where to pick up when this source loads, clamped to its real length.
   *
   * Switching cuts is the reason this is a prop rather than an imperative call:
   * the seek belongs to the NEW file, and at the moment the user taps 改一 the
   * old <video> is still the mounted one.
   */
  startAt?: number;
  /** Re-sign the storage URL. Called once when playback fails on an expired URL. */
  onNeedsFreshUrl?: () => Promise<string | null>;
  /** Fires ~4×/s while playing, plus on every seek. Not once per frame. */
  onTimeUpdate?: (seconds: number) => void;
  onDurationChange?: (seconds: number) => void;
  /** Continuous playhead for the timeline: called on every animation frame. */
  onFrame?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  className?: string;
};

type Failure = { message: string; canRetry: boolean };

export const VideoPlayer = forwardRef<PlayerHandle, Props>(function VideoPlayer(
  {
    src,
    srcKey,
    poster,
    mimeType,
    knownDuration,
    startAt,
    onNeedsFreshUrl,
    onTimeUpdate,
    onDurationChange,
    onFrame,
    onPlayingChange,
    className,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(knownDuration ?? 0);
  const [clock, setClock] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [buffering, setBuffering] = useState(false);
  /**
   * The URL actually handed to the element. Pinned on mount and on a genuine
   * media change; a re-signed URL for the same path is deliberately ignored.
   */
  const [playbackSrc, setPlaybackSrc] = useState(src);
  const latestSrc = useRef(src);
  latestSrc.current = src;
  /** One re-sign attempt per source; a second failure is a real failure. */
  const refreshed = useRef(false);
  /** A seek asked for before the metadata arrived (e.g. switching cuts). */
  const pendingSeek = useRef<{ seconds: number; play: boolean } | null>(null);
  // Read inside the source-change effect, which must depend on srcKey alone.
  const startAtRef = useRef(startAt);
  startAtRef.current = startAt;
  const knownDurationRef = useRef(knownDuration);
  knownDurationRef.current = knownDuration;
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;
  const clockRef = useRef(0);

  // A new source means a new everything: nothing measured about the previous
  // cut may leak into this one's clock, timeline or resume point.
  useEffect(() => {
    refreshed.current = false;
    pendingSeek.current = startAtRef.current != null ? { seconds: startAtRef.current, play: false } : null;
    clockRef.current = 0;
    setFailure(null);
    setClock(0);
    setPlaying(false);
    setDuration(knownDurationRef.current ?? 0);
    // Adopt whatever URL is current for the NEW path. Reading it from a ref
    // keeps this effect keyed on identity alone, so a re-signed URL for the
    // same video never restarts playback.
    setPlaybackSrc(latestSrc.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);

  useEffect(() => {
    if (knownDuration && knownDuration > 0) setDuration((d) => (d > 0 ? d : knownDuration));
  }, [knownDuration]);

  useImperativeHandle(
    ref,
    () => ({
      seek: (seconds, opts) => {
        const v = videoRef.current;
        if (!v) return;
        if (v.readyState === 0) {
          // Metadata is not in yet, so we cannot clamp and the browser would
          // drop the assignment. Remember it and apply it on loadedmetadata.
          pendingSeek.current = { seconds, play: Boolean(opts?.play) };
          return;
        }
        const max = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : seconds;
        v.currentTime = Math.max(0, Math.min(seconds, max));
        clockRef.current = v.currentTime;
        setClock(v.currentTime);
        frameRef.current?.(v.currentTime);
        onTimeUpdate?.(v.currentTime);
        if (opts?.play) void v.play().catch(() => undefined);
      },
      pause: () => videoRef.current?.pause(),
      currentTime: () => videoRef.current?.currentTime ?? clockRef.current,
      duration: () => {
        const v = videoRef.current;
        return v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : duration;
      },
      isPaused: () => videoRef.current?.paused ?? true,
    }),
    [duration, onTimeUpdate],
  );

  // The animation loop only exists while the video is actually playing, so an
  // idle room costs nothing. Paused seeks still paint through the seek handler.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let lastPublish = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const t = v.currentTime;
        clockRef.current = t;
        frameRef.current?.(t);
        // React only hears about it four times a second — enough for a clock,
        // cheap enough that the discussion list is not re-rendered per frame.
        if (t - lastPublish > 0.25 || t < lastPublish) {
          lastPublish = t;
          setClock(t);
          onTimeUpdate?.(t);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, onTimeUpdate]);

  const setPlayState = useCallback(
    (next: boolean) => {
      setPlaying(next);
      onPlayingChange?.(next);
    },
    [onPlayingChange],
  );

  /**
   * Tell the viewer WHY a file will not play when the browser can say so up
   * front. An iPhone .mov is the common case: it plays for the person who
   * uploaded it and not for the partner they sent it to.
   */
  const unsupportedNote = useCallback((mime?: string): string | null => {
    if (!mime) return null;
    const probe = document.createElement("video");
    if (probe.canPlayType(mime)) return null;
    if (mime === "video/quicktime") {
      return "這支是 iPhone 的影片格式，這個瀏覽器可能播不出來。用 Safari 開，或請主辦方輸出成 MP4（H.264）。";
    }
    return "這個瀏覽器播不出這種影片格式，建議改成 MP4（H.264）。";
  }, []);

  /**
   * A signed Storage URL expires. When playback dies, ask for a fresh one once
   * and resume where the viewer was — an expiry should look like a hiccup, not
   * like a broken video.
   */
  const handleError = useCallback(async () => {
    const v = videoRef.current;
    const at = v?.currentTime ?? 0;
    if (!refreshed.current && onNeedsFreshUrl) {
      refreshed.current = true;
      setBuffering(true);
      const fresh = await onNeedsFreshUrl().catch(() => null);
      setBuffering(false);
      if (fresh) {
        // Resume where the viewer was: an expired signature should feel like a
        // hiccup, not like the video restarted.
        pendingSeek.current = { seconds: at, play: false };
        setPlaybackSrc(fresh);
        return;
      }
    }
    setFailure({
      message: !navigator.onLine
        ? "目前離線，影片需要連線才能播放；留言仍然可以看。"
        : (unsupportedNote(mimeType) ?? "這支影片目前無法播放，可以重新整理，或請主辦方重新上傳。"),
      canRetry: true,
    });
    setPlayState(false);
  }, [onNeedsFreshUrl, setPlayState, unsupportedNote, mimeType]);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const nudge = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    const max = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : v.currentTime + delta;
    v.currentTime = Math.max(0, Math.min(v.currentTime + delta, max));
    clockRef.current = v.currentTime;
    setClock(v.currentTime);
    frameRef.current?.(v.currentTime);
  }, []);

  const fullscreen = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    // iOS Safari only offers its own fullscreen on the element itself.
    const anyVideo = v as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else if (v.requestFullscreen) {
      void v.requestFullscreen().catch(() => anyVideo.webkitEnterFullscreen?.());
    } else {
      anyVideo.webkitEnterFullscreen?.();
    }
  }, []);

  const cycleRate = useCallback(() => {
    const steps = [1, 1.5, 2, 0.5];
    const next = steps[(steps.indexOf(rate) + 1) % steps.length];
    setRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  }, [rate]);

  return (
    <div className={`v-player ${className ?? ""}`}>
      <div className="v-frame">
        <video
          ref={videoRef}
          className="v-video"
          src={playbackSrc}
          poster={poster || undefined}
          playsInline
          preload="metadata"
          // No `controls`: the app owns the controls so the timeline and the
          // discussion stay in step. Native fullscreen still shows its own.
          onClick={toggle}
          onPlay={() => setPlayState(true)}
          onPause={() => setPlayState(false)}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => {
            setBuffering(false);
            setFailure(null);
          }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            const known = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
            if (known > 0) {
              setDuration(known);
              onDurationChange?.(known);
            }
            v.playbackRate = rate;
            // A cut switched to at 00:35 lands on a cut that may be shorter:
            // clamp instead of assigning past the end, which browsers handle
            // inconsistently (some stall silently).
            const queued = pendingSeek.current;
            if (queued) {
              pendingSeek.current = null;
              const max = known > 0 ? Math.max(0, known - 0.05) : queued.seconds;
              v.currentTime = Math.max(0, Math.min(queued.seconds, max));
              clockRef.current = v.currentTime;
              setClock(v.currentTime);
              frameRef.current?.(v.currentTime);
              onTimeUpdate?.(v.currentTime);
              if (queued.play) void v.play().catch(() => undefined);
            }
          }}
          onSeeked={(e) => {
            const t = e.currentTarget.currentTime;
            clockRef.current = t;
            setClock(t);
            frameRef.current?.(t);
            onTimeUpdate?.(t);
          }}
          onTimeUpdate={(e) => {
            // Covers the paused case and browsers that throttle rAF in the
            // background; the rAF loop handles the smooth case while playing.
            if (playing) return;
            const t = e.currentTarget.currentTime;
            clockRef.current = t;
            setClock(t);
            frameRef.current?.(t);
          }}
          onEnded={() => setPlayState(false)}
          onError={() => void handleError()}
        />

        {!playing && !failure && (
          <button type="button" className="v-bigplay" onClick={toggle} aria-label="播放">
            <span aria-hidden>▶</span>
          </button>
        )}
        {buffering && !failure && <span className="v-spinner" role="status" aria-label="載入中" />}
        {failure && (
          <div className="v-failure" role="alert">
            <p>{failure.message}</p>
            <button
              type="button"
              className="m-btn"
              onClick={() => {
                setFailure(null);
                refreshed.current = false;
                videoRef.current?.load();
              }}
            >
              再試一次
            </button>
          </div>
        )}
      </div>

      <div className="v-controls">
        <button type="button" className="v-ctl v-ctl-play" onClick={toggle} aria-label={playing ? "暫停" : "播放"}>
          <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
        </button>
        <button type="button" className="v-ctl" onClick={() => nudge(-5)} aria-label="倒退 5 秒">
          <span aria-hidden>-5</span>
        </button>
        <button type="button" className="v-ctl" onClick={() => nudge(5)} aria-label="前進 5 秒">
          <span aria-hidden>+5</span>
        </button>
        <span className="v-clock" aria-label={`目前 ${formatTime(clock)}，全長 ${formatTime(duration)}`}>
          {formatTime(clock)} <em>/</em> {formatTime(duration)}
        </span>
        <button
          type="button"
          className="v-ctl"
          onClick={() => {
            const v = videoRef.current;
            if (!v) return;
            v.muted = !v.muted;
            if (!v.muted && v.volume === 0) {
              v.volume = 1;
              setVolume(1);
            }
            setMuted(v.muted);
          }}
          aria-label={muted ? "取消靜音" : "靜音"}
        >
          <span aria-hidden>{muted ? "🔇" : "🔊"}</span>
        </button>
        <input
          className="v-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          aria-label="音量"
          onChange={(e) => {
            const next = Number(e.target.value);
            setVolume(next);
            const v = videoRef.current;
            if (!v) return;
            v.volume = next;
            // Dragging away from zero is how a phone user unmutes; making them
            // find the mute button again would be a puzzle, not a control.
            v.muted = next === 0;
            setMuted(v.muted);
          }}
        />
        <button type="button" className="v-ctl v-ctl-rate" onClick={cycleRate} aria-label={`播放速度 ${rate} 倍`}>
          {rate}×
        </button>
        <button type="button" className="v-ctl" onClick={fullscreen} aria-label="全螢幕">
          <span aria-hidden>⛶</span>
        </button>
      </div>
    </div>
  );
});
