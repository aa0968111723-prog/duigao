import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  REACTION_LABEL,
  type CommentPin,
  type ReactionType,
  type Verdict,
  type VideoAnchor,
  type VideoCategory,
  type Version,
} from "../../lib/types";
import type { CollabStatus } from "../../lib/peer";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useViewport } from "../../hooks/useViewport";
import { DragSheet, ModalSheet, type SheetSnap } from "../../components/BottomSheet";
import { IconChat, IconEye, IconMore, IconPen, IconPin } from "../../components/icons";
import { pinNumber, type WorkspaceApi } from "../../components/api";
import { VideoPlayer, type PlayerHandle } from "./VideoPlayer";
import { VideoTimeline, type ReactionCluster, type TimelineMarker } from "./VideoTimeline";
import { ReviewBrief } from "./ReviewBrief";
import { QuickReactions } from "./QuickReactions";
import { VerdictSheet } from "./VerdictSheet";
import { ReviewSummary } from "./ReviewSummary";
import { summarize } from "./summary";
import { VideoDiscussion, videoCommentsOf, sortVideoComments } from "./VideoDiscussion";
import { VideoCommentComposer } from "./VideoCommentComposer";
import { VideoVersionSelector } from "./VideoVersionSelector";
import { anchorEnd, anchorStart, makePoint, makeRange, MIN_RANGE_SECONDS } from "./anchors";
import { formatTime } from "./media";
import type { RoomContextFocus } from "../../lib/assetIntelligence";
import "./video.css";

/**
 * 影片對稿 — the whole workspace.
 *
 * Shaped by one sentence from the spec: **the player is the screen.** The video
 * gets the room; the timeline is a thin band under it; the discussion lives in
 * the same bottom sheet the poster app uses, so a reviewer who has used one
 * already knows this one. 看｜修改｜討論｜更多 keeps its meaning — only what
 * 修改 offers changes, because you cannot point at a corner of a moving image.
 */

type Props = {
  api: WorkspaceApi;
  presence: { status: CollabStatus | null; peers: number };
};

/** Picking a stretch: start is locked, end follows the video until confirmed. */
type RangePick = { start: number; end: number | null };

export function VideoWorkspace({ api, presence }: Props) {
  const { room, view, guest } = api;
  const aiFocusTarget: RoomContextFocus | null | undefined = api.ai?.focusTarget;
  const isMobile = useIsMobile();
  const viewportHeight = useViewport();
  const playerRef = useRef<PlayerHandle>(null);

  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [more, setMore] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [composeInset, setComposeInset] = useState(0);
  const [draft, setDraft] = useState<VideoAnchor | null>(null);
  const [rangePick, setRangePick] = useState<RangePick | null>(null);
  const [liveTime, setLiveTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const aiFocusKeyRef = useRef<string | null>(null);
  /**
   * Where the NEW cut should pick up after a version switch (spec §20).
   *
   * Held in state, not applied imperatively: at the moment 改一 is tapped the
   * outgoing <video> is still mounted, so a seek would land on the wrong file.
   */
  const [startAt, setStartAt] = useState<number | undefined>(api.openAtSeconds);
  /* -------------------------------------------- 影片對稿 2.0 state (#32) -- */
  /** Optional bucket for the draft. Null means "did not say", which is fine. */
  const [draftCategory, setDraftCategory] = useState<VideoCategory | null>(null);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [verdictOpen, setVerdictOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  /**
   * The end-of-video prompt is offered ONCE per cut per visit. Asking again
   * every time somebody scrubs back past the 90% mark would turn a light
   * question into nagging.
   */
  const verdictAskedRef = useRef<string | null>(null);
  /**
   * Whether the person is in the middle of something.
   *
   * The end-of-video question must never interrupt: reaching 92% while someone
   * is typing feedback, picking a range, or reading another sheet is not an
   * invitation to throw a scrim over their work. Held in a ref so the frame
   * listener can read it without re-subscribing on every keystroke.
   */
  const busyRef = useRef(false);
  /**
   * The live clock, without re-rendering to hold it.
   *
   * `liveTime` state only moves while something on screen actually shows a
   * time (the action sheet, a range being picked). Otherwise the number lives
   * here and the discussion list is left alone — a playing video must not
   * re-render every card four times a second (spec §16).
   */
  const liveTimeRef = useRef(0);

  const version = useMemo(
    () => room.versions.find((v) => v.id === view.versionId) ?? room.versions[0],
    [room.versions, view.versionId],
  );

  /**
   * The per-frame playhead bus.
   *
   * The player publishes here on every animation frame and the timeline paints
   * straight to the DOM. Keeping it in a ref means the video can play for an
   * hour without React re-rendering the discussion once (spec §16).
   */
  const frameListeners = useRef(new Set<(t: number) => void>());
  const publishFrame = useCallback((t: number) => {
    frameListeners.current.forEach((fn) => fn(t));
  }, []);
  const subscribeFrame = useCallback((fn: (t: number) => void) => {
    frameListeners.current.add(fn);
    return () => {
      frameListeners.current.delete(fn);
    };
  }, []);

  // While picking the end of a range, the live end has to follow the video —
  // that IS the interaction. Everything else reads the ref.
  busyRef.current = Boolean(draft) || rangePick !== null || actionOpen || more || summaryOpen;

  const showsClock = actionOpen || rangePick !== null;
  const showsClockRef = useRef(showsClock);
  showsClockRef.current = showsClock;

  const onTimeUpdate = useCallback((t: number) => {
    liveTimeRef.current = t;
    if (showsClockRef.current) setLiveTime(t);
    setRangePick((pick) => (pick && pick.end !== t ? { ...pick, end: t } : pick));
  }, []);

  // Opening the sheet needs the current time immediately, not at the next beat.
  useEffect(() => {
    if (showsClock) setLiveTime(liveTimeRef.current);
  }, [showsClock]);

  const videoComments = useMemo(
    () => (version ? videoCommentsOf(room, version.id) : []),
    [room, version],
  );

  /* ------------------------------------------------- 影片對稿 2.0 (#32) -- */

  const review = api.video?.review;
  const canManageReview = api.video?.canManageReview ?? false;
  const reviewOnline = api.video?.reviewOnline ?? false;
  const myUserId = api.video?.myUserId ?? "";

  const brief = useMemo(
    () => review?.briefs.find((b) => b.versionId === version?.id) ?? null,
    [review, version],
  );

  const versionReactions = useMemo(
    () => review?.reactions.filter((r) => r.versionId === version?.id) ?? [],
    [review, version],
  );

  const myVerdict = useMemo(
    () => review?.verdicts.find((v) => v.versionId === version?.id && v.userId === myUserId) ?? null,
    [review, version, myUserId],
  );

  /**
   * Merge reactions that land within a couple of seconds of each other into one
   * mark. Same window the database dedupes a single person's double-tap with,
   * so what the timeline shows and what the row-level guard enforces agree.
   */
  const reactionClusters: ReactionCluster[] = useMemo(() => {
    const WINDOW = 2;
    const byType = new Map<ReactionType, { time: number; count: number }[]>();
    for (const r of [...versionReactions].sort((a, b) => a.time - b.time)) {
      const list = byType.get(r.type) ?? [];
      const last = list[list.length - 1];
      if (last && r.time - last.time <= WINDOW) {
        // Keep the cluster anchored where it started rather than drifting later
        // with every new tap.
        last.count += 1;
      } else {
        list.push({ time: r.time, count: 1 });
      }
      byType.set(r.type, list);
    }
    const out: ReactionCluster[] = [];
    for (const [type, groups] of byType) {
      const { emoji, text } = REACTION_LABEL[type];
      for (const g of groups) {
        out.push({
          id: `${type}-${g.time.toFixed(2)}`,
          time: g.time,
          emoji,
          count: g.count,
          label: `${formatTime(g.time)} ${text}${g.count > 1 ? ` ×${g.count}` : ""}`,
        });
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }, [versionReactions]);

  const summary = useMemo(
    () =>
      summarize({
        comments: videoComments,
        reactions: versionReactions,
        verdicts: review?.verdicts.filter((v) => v.versionId === version?.id) ?? [],
        progress: review?.progress.filter((p) => p.versionId === version?.id) ?? [],
        duration: duration || version?.duration || 0,
      }),
    [videoComments, versionReactions, review, version, duration],
  );

  const markers: TimelineMarker[] = useMemo(
    () =>
      sortVideoComments(videoComments, "time").map((c) => ({
        id: c.id,
        number: pinNumber(room, c.id),
        start: anchorStart(c),
        end: anchorEnd(c),
        resolved: c.resolved,
        color: c.authorColor,
      })),
    [videoComments, room],
  );

  const openCount = videoComments.filter((c) => !c.resolved).length;

  const seekTo = useCallback(
    (seconds: number, play = false) => {
      playerRef.current?.seek(seconds, { play });
      liveTimeRef.current = seconds;
      if (showsClockRef.current) setLiveTime(seconds);
      publishFrame(seconds);
    },
    [publishFrame],
  );

  // A room-AI citation can point at a precise temporal segment. The normal
  // player remains the source of truth; this only seeks it and opens the
  // existing discussion sheet so the reviewer stays in the video workspace.
  useEffect(() => {
    const locator = aiFocusTarget?.locator;
    if (!version || aiFocusTarget?.versionId !== version.id || locator?.kind !== "video-segment") return;
    const focusKey = `${version.id}:ai:${aiFocusTarget.assetId}:${locator.startSeconds}:${locator.endSeconds}`;
    if (aiFocusKeyRef.current === focusKey) return;
    aiFocusKeyRef.current = focusKey;
    seekTo(locator.startSeconds, false);
    setSnap((current) => (current === "peek" ? "half" : current));
  }, [aiFocusTarget, seekTo, version?.id]);

  /** Tapping a card or a marker: go to that moment and select it. */
  const focusComment = useCallback(
    (pin: CommentPin) => {
      const target = anchorStart(pin);
      api.selectPin(pin.id);
      if (pin.versionId !== view.versionId) {
        // Cross-version: the seek belongs to the cut that is about to load, so
        // it travels with the source rather than hitting the outgoing element.
        setRangePick(null);
        setStartAt(target);
        liveTimeRef.current = target;
        setLiveTime(target);
        publishFrame(target);
        api.setView({ ...view, versionId: pin.versionId, compareMode: "single" });
        return;
      }
      seekTo(target);
    },
    [api, view, seekTo, publishFrame],
  );

  const selectMarker = useCallback(
    (id: string) => {
      const pin = room.comments.find((c) => c.id === id);
      if (!pin) return;
      focusComment(pin);
      setSnap((s) => (s === "peek" ? "half" : s));
    },
    [room.comments, focusComment],
  );

  // Selecting from elsewhere (realtime, a marker) scrolls the card into view,
  // exactly like the poster workspace does.
  useEffect(() => {
    if (!api.selectedPinId) return;
    const id = window.setTimeout(() => {
      document.getElementById(`pin-card-${api.selectedPinId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 220);
    return () => window.clearTimeout(id);
  }, [api.selectedPinId]);

  /**
   * A tap on 一鍵反應.
   *
   * The moment comes from the player, not from the person: they are watching,
   * not timing. The video is NOT paused — that is the difference between this
   * and leaving a comment, and it is the whole reason people will use it.
   */
  const react = useCallback(
    (type: ReactionType) => {
      if (!version || !api.video) return;
      const at = playerRef.current?.currentTime() ?? liveTimeRef.current;
      api.video.react(version.id, at, type);
      api.showToast(`已記在 ${formatTime(at)}`);
    },
    [version, api],
  );

  const submitVerdict = useCallback(
    (verdict: Verdict, note?: string) => {
      if (!version || !api.video) return;
      api.video.setVerdict(version.id, verdict, note);
      api.showToast("已記下你的看法，謝謝！", { tone: "success" });
    },
    [version, api],
  );

  /**
   * Tell the room how far this person got.
   *
   * Two numbers, and only ever forwards — the database refuses to move the
   * maximum backwards, so re-watching a passage cannot rewrite it. Sent on a
   * lazy schedule (see the effect below) because nobody needs it live.
   */
  const reportProgress = useCallback(
    (completed: boolean) => {
      if (!version || !api.video || !reviewOnline) return;
      const at = playerRef.current?.currentTime() ?? liveTimeRef.current;
      if (at <= 0 && !completed) return;
      api.video.reportProgress(version.id, at, completed);
    },
    [version, api, reviewOnline],
  );

  /** 這一刻留意見: freeze the frame being talked about, then ask about it. */
  const startPoint = useCallback(() => {
    setActionOpen(false);
    playerRef.current?.pause();
    const at = playerRef.current?.currentTime() ?? liveTimeRef.current;
    setRangePick(null);
    setDraft(makePoint(at, duration));
    setSnap("peek");
  }, [duration]);

  /** 選一段留意見: lock the start now, let the video (or a scrub) find the end. */
  const startRange = useCallback(() => {
    setActionOpen(false);
    const at = playerRef.current?.currentTime() ?? liveTimeRef.current;
    setDraft(null);
    setRangePick({ start: at, end: null });
    setSnap("peek");
  }, []);

  const confirmRange = useCallback(() => {
    if (!rangePick) return;
    const end = playerRef.current?.currentTime() ?? rangePick.end ?? rangePick.start;
    const anchor = makeRange(rangePick.start, end, duration);
    if (!anchor) {
      api.showToast(`再往後一點：一段至少要 ${MIN_RANGE_SECONDS} 秒。`, { tone: "error" });
      return;
    }
    playerRef.current?.pause();
    setRangePick(null);
    setDraft(anchor);
  }, [rangePick, duration, api]);

  const cancelDraft = useCallback(() => {
    setDraft(null);
    setRangePick(null);
    setDraftCategory(null);
    setComposeInset(0);
    api.cancelPin();
  }, [api]);

  const submitDraft = useCallback(() => {
    if (!draft) return;
    api.video?.commitVideoComment(draft, draftCategory ?? undefined);
    setDraft(null);
    setRangePick(null);
    setDraftCategory(null);
    setComposeInset(0);
  }, [draft, api, draftCategory]);

  /**
   * 改成一段 — promote the moment being written about into a stretch.
   *
   * The typed sentence survives (it lives in `api.form`, not here): someone who
   * has already explained the problem should not have to retype it because they
   * realised it is about six seconds rather than one frame.
   */
  const promoteToRange = useCallback(() => {
    if (!draft || draft.kind !== "point") return;
    setDraft(null);
    setRangePick({ start: draft.time, end: null });
    playerRef.current?.seek(draft.time, { play: true });
    api.showToast("播到結束的地方，再按「設為結束」。");
  }, [draft, api]);

  /**
   * Switching cuts holds the moment (spec §20). A shorter cut clamps to its own
   * end instead of refusing, so 改二 being 10 seconds tighter never strands the
   * viewer past the end of the file.
   */
  const switchVersion = useCallback(
    (versionId: string) => {
      if (versionId === view.versionId) return;
      // A pending seek outranks the element's clock: right after a switch the
      // new <video> reads 0 while the moment we are carrying is the one the
      // reviewer actually asked for.
      const at =
        playerRef.current?.pendingTarget() ?? playerRef.current?.currentTime() ?? liveTimeRef.current;
      const next = room.versions.find((v) => v.id === versionId);
      const cap = next?.duration && next.duration > 0 ? next.duration : undefined;
      // A shorter cut clamps rather than refusing; an unknown length resumes at
      // the same moment and the player clamps again once metadata lands.
      const target = cap ? Math.min(at, Math.max(0, cap - 0.1)) : at;
      playerRef.current?.pause();
      api.selectPin(null);
      // A half-picked range belongs to the cut it was started on: its start was
      // read off THAT timeline, so carrying it into another cut would file a
      // range whose beginning nobody ever saw here.
      setRangePick(null);
      // The resume point travels WITH the new source. Seeking here would land
      // on the outgoing element, and the new cut would start at 0:00 (§20).
      setStartAt(target);
      setDuration(cap ?? 0);
      liveTimeRef.current = target;
      setLiveTime(target);
      publishFrame(target);
      api.setView({ ...view, versionId, compareMode: "single" });
    },
    [view, api, room.versions, publishFrame],
  );

  /**
   * Progress + the end-of-video question.
   *
   * Both ride the existing per-frame bus rather than adding listeners to the
   * <video>. Progress is written at most once every 15 seconds and once more on
   * unmount — a review session should cost a handful of rows, not one per
   * second — and the verdict prompt fires once, at 92%, per cut per visit.
   */
  useEffect(() => {
    if (!version || !reviewOnline) return;
    let lastSent = 0;
    let latest = 0;

    const unsubscribe = subscribeFrame((t) => {
      latest = t;
      const total = playerRef.current?.duration() ?? duration;
      const now = Date.now();
      if (now - lastSent > 15000) {
        lastSent = now;
        reportProgress(false);
      }
      if (
        total > 0 &&
        t >= total * 0.92 &&
        verdictAskedRef.current !== version.id &&
        // Someone who has already said what they think does not need asking
        // again; they can still change it from 更多.
        !myVerdict &&
        // …and never on top of whatever they are already doing.
        !busyRef.current
      ) {
        verdictAskedRef.current = version.id;
        reportProgress(true);
        setVerdictOpen(true);
      }
    });

    return () => {
      unsubscribe();
      // Leaving the room or switching cuts: record where they actually got to,
      // otherwise a partner who watched 50 seconds and closed the tab reads as
      // never having opened it.
      if (latest > 0) reportProgress(false);
    };
  }, [version, reviewOnline, duration, myVerdict, subscribeFrame, reportProgress]);

  // A different cut is a different question, so the once-per-cut guard resets.
  useEffect(() => {
    if (verdictAskedRef.current && verdictAskedRef.current !== version?.id) {
      verdictAskedRef.current = null;
    }
  }, [version?.id]);

  // Space / arrows, but never while the viewer is typing feedback.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      // Space is how a keyboard presses the button it is focused on, so it is
      // left alone for anything that would consume it. A slider is focusable
      // but does NOT use Space — and the timeline is the control people leave
      // focus on, so treating it as "busy" would kill the shortcut for the rest
      // of the session after a single scrub.
      if (el?.closest('button, a, select, summary, [role="button"]')) {
        if (e.key !== "Escape") return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        const p = playerRef.current;
        if (!p) return;
        if (p.isPaused()) p.seek(p.currentTime(), { play: true });
        else p.pause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekTo(Math.max(0, (playerRef.current?.currentTime() ?? 0) - 5));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const p = playerRef.current;
        const max = p?.duration() ?? duration;
        seekTo(Math.min(max, (p?.currentTime() ?? 0) + 5));
      } else if (e.key === "Escape") {
        // 消費掉的 Escape 標記 defaultPrevented：外層（對稿 overlay）以此
        // 判斷這一下已被內層 ladder 用掉，一次只關一件事。
        if (draft) { e.preventDefault(); cancelDraft(); }
        else if (rangePick) { e.preventDefault(); setRangePick(null); }
        else if (api.selectedPinId) { e.preventDefault(); api.selectPin(null); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seekTo, duration, draft, rangePick, api, cancelDraft]);

  const upload = api.video?.upload ?? null;
  const uploading = upload?.state === "uploading";

  if (!version) return null;

  const player = (
    <VideoPlayer
      ref={playerRef}
      src={version.videoUrl ?? ""}
      // Identity, not the signed URL: see VideoPlayer's srcKey. Falling back to
      // the version id keeps a locally-added cut stable before its row lands.
      srcKey={version.videoPath ?? version.id}
      poster={version.imageDataUrl}
      mimeType={version.mimeType}
      knownDuration={version.duration}
      startAt={startAt}
      onNeedsFreshUrl={api.video?.refreshVideoUrl}
      onTimeUpdate={onTimeUpdate}
      onDurationChange={setDuration}
      onFrame={publishFrame}
    />
  );

  const timeline = (
    <VideoTimeline
      duration={duration || version.duration || 0}
      subscribe={subscribeFrame}
      markers={markers}
      reactions={reactionClusters}
      selectedId={api.selectedPinId}
      onSeek={(t) => seekTo(t)}
      onSelectMarker={selectMarker}
      selection={rangePick}
    />
  );

  // Memoized on what it actually shows: a playing video must not re-render
  // every card, and the clock deliberately is not one of these inputs (§16).
  const feedbackList = useMemo(
    () => (
      <VideoDiscussion
        api={api}
        versionId={version.id}
        selectedId={api.selectedPinId}
        onSelect={focusComment}
        compact={isMobile}
      />
    ),
    [api, version.id, focusComment, isMobile],
  );
  // 房級討論 drawer（雲端 single 房才有）；有的話討論位變成
  // 「回饋｜房間討論」兩段，回饋維持既有的逐格意見流程。
  const [discussTab, setDiscussTab] = useState<"feedback" | "room">("feedback");
  const discussion = api.discussionDrawer ? (
    <>
      <div className="m-sheet-tabs v-discuss-tabs">
        <button type="button" className={discussTab === "feedback" ? "is-on" : ""} onClick={() => setDiscussTab("feedback")}>回饋</button>
        <button type="button" className={discussTab === "room" ? "is-on" : ""} onClick={() => setDiscussTab("room")}>房間討論</button>
      </div>
      {discussTab === "feedback" ? feedbackList : api.discussionDrawer}
    </>
  ) : (
    feedbackList
  );

  const briefCard = version && (
    <ReviewBrief
      brief={brief}
      canEdit={canManageReview}
      online={reviewOnline}
      onSave={(input) => api.video?.saveBrief(version.id, input)}
    />
  );

  /**
   * The one action a partner is meant to find without being told.
   *
   * It reads the clock itself and pauses — nobody types a timecode, and nobody
   * has to hunt for the pause button first. The 快速反應 row underneath is
   * collapsed by default so the first screen stays "video + one button".
   */
  const captureBar = (
    <div className="v-capture">
      <button type="button" className="v-capture-main" onClick={startPoint}>
        ＋ 在這裡留言
      </button>
      <button
        type="button"
        className="m-link v-capture-toggle"
        aria-expanded={reactionsOpen}
        onClick={() => setReactionsOpen((o) => !o)}
      >
        快速反應 {reactionsOpen ? "▾" : "›"}
      </button>
      {reactionsOpen && <QuickReactions onReact={react} disabled={!reviewOnline} />}
    </div>
  );

  const verdictSheet = verdictOpen && (
    <VerdictSheet
      current={myVerdict?.verdict ?? null}
      currentNote={myVerdict?.note}
      onSubmit={submitVerdict}
      onClose={() => setVerdictOpen(false)}
    />
  );

  const summarySheet = summaryOpen && version && (
    <ModalSheet title="審片摘要" onClose={() => setSummaryOpen(false)}>
      <div className="m-more">
        <ReviewSummary
          label={version.label}
          summary={summary}
          onSeek={(t) => {
            setSummaryOpen(false);
            seekTo(t);
          }}
        />
      </div>
    </ModalSheet>
  );

  const moreSheet = more && (
    <ModalSheet title="更多" onClose={() => setMore(false)}>
      <div className="m-more">
        <div className="m-more-group">
          <span className="m-more-label">這一版</span>
          <p className="v-more-meta">
            {version.label}
            {version.duration ? ` · ${formatTime(version.duration)}` : ""}
            {version.width && version.height ? ` · ${version.width}×${version.height}` : ""}
          </p>
        </div>
        {canManageReview && reviewOnline && (
          <button
            type="button"
            className="m-row"
            onClick={() => {
              setMore(false);
              setSummaryOpen(true);
            }}
          >
            審片摘要
          </button>
        )}
        {reviewOnline && (
          <button
            type="button"
            className="m-row"
            onClick={() => {
              setMore(false);
              setVerdictOpen(true);
            }}
          >
            {myVerdict ? "改變我的看法" : "看完了，給個看法"}
          </button>
        )}
        {api.ai && (
          <button
            type="button"
            className="m-row"
            onClick={() => {
              setMore(false);
              const asset = api.ai?.assets.find((item) => item.versionId === version.id);
              api.ai?.open(asset?.id);
            }}
          >
            ✦ 問房間 AI
          </button>
        )}
        <button type="button" className="m-row" onClick={api.undo} disabled={!api.canUndo}>
          復原上一個操作
        </button>
        {videoComments.length > 0 && (
          <button type="button" className="m-row" onClick={api.copySummary}>
            複製修改清單
          </button>
        )}
        <p className="v-more-note">
          影片本身需要連線才能播放；房間資訊與留言離線時仍看得到。
        </p>
      </div>
    </ModalSheet>
  );

  const sheets = (
    <>
      {actionOpen && (
        <ModalSheet title="新增修改" onClose={() => setActionOpen(false)}>
          <div className="m-action">
            <button type="button" className="m-action-btn" onClick={startPoint}>
              <IconPin />
              <span className="m-action-copy">
                <b>這一刻留意見</b>
                <small>停在現在的畫面（{formatTime(liveTime)}）留一句</small>
              </span>
            </button>
            <button type="button" className="m-action-btn" onClick={startRange}>
              <IconPen />
              <span className="m-action-copy">
                <b>選一段留意見</b>
                <small>從現在開始，播到結束的地方再按一次</small>
              </span>
            </button>
          </div>
        </ModalSheet>
      )}

      {draft && (
        <VideoCommentComposer
          api={api}
          anchor={draft}
          category={draftCategory}
          onCategory={setDraftCategory}
          onMakeRange={promoteToRange}
          onRepick={() => {
            setDraft(null);
            setActionOpen(true);
          }}
          onCancel={cancelDraft}
          onSubmit={submitDraft}
          onHeight={setComposeInset}
        />
      )}

      {moreSheet}
      {verdictSheet}
      {summarySheet}
    </>
  );

  const rangeBar = rangePick && !draft && (
    <div className="m-status v-rangebar" role="status">
      <span className="m-status-text">
        開始 {formatTime(rangePick.start)} → 現在 {formatTime(rangePick.end ?? rangePick.start)}
      </span>
      <button type="button" className="m-btn m-btn-primary m-btn-sm" onClick={confirmRange}>
        設為結束
      </button>
      <button type="button" className="m-status-cancel" onClick={() => setRangePick(null)}>
        取消
      </button>
    </div>
  );

  const uploadBar = upload && upload.state !== "idle" && (
    <div className="v-upload" role="status" aria-live="polite">
      <span className="v-upload-text">
        {upload.state === "uploading"
          ? `正在上傳影片 ${Math.round(upload.progress * 100)}%`
          : upload.state === "processing"
            ? "正在處理影片…"
            : upload.state === "error"
              ? upload.message
              : "正在準備影片…"}
      </span>
      {upload.state === "uploading" && (
        <span className="v-upload-bar" aria-hidden>
          <span className="v-upload-fill" style={{ width: `${Math.round(upload.progress * 100)}%` }} />
        </span>
      )}
      {/* A banner with no way to dismiss it is a banner that stays forever. */}
      {(upload.state === "uploading" || upload.state === "preparing" || upload.state === "error") && (
        <button type="button" className="m-status-cancel" onClick={upload.cancel}>
          {upload.state === "error" ? "知道了" : "取消"}
        </button>
      )}
    </div>
  );

  if (!isMobile) {
    // Desktop: player + timeline on the left, discussion on the right. Not a
    // multi-track editor — this is still a conversation about a cut.
    return (
      <div className="app v-desktop-app">
        <header className="topbar">
          <button className="brand" onClick={api.goHome}>
            <span className="brand-dot" />
            影片對稿
          </button>
          <input
            className="title-input"
            value={room.title}
            onChange={(e) => api.setTitle(e.target.value)}
            aria-label="影片名稱"
          />
          <div className="topbar-right">
            {api.saveState !== "idle" && (
              <span className={`save-status save-${api.saveState}`}>
                {api.saveState === "saving" ? "儲存中…" : api.saveState === "saved" ? "已儲存" : "儲存失敗"}
              </span>
            )}
            {presence.status && (
              <span
                className={`badge badge-${presence.status}`}
                title={presence.status === "online" ? `${presence.peers} 人同時在線` : "同步狀態"}
              >
                {presence.status === "online"
                  ? presence.peers > 1
                    ? `已同步 · ${presence.peers} 人`
                    : "已同步"
                  : presence.status === "connecting"
                    ? "正在同步"
                    : "目前離線"}
              </span>
            )}
            <span className="me" style={{ background: guest.color }} title={guest.name}>
              {guest.name.slice(0, 1)}
            </span>
            <button className="btn btn-primary" onClick={api.openShare}>
              分享
            </button>
          </div>
        </header>

      <div className="v-desktop">
        <section className="v-desktop-main">
          <VideoVersionSelector
            versions={room.versions}
            currentId={version.id}
            onSelect={switchVersion}
            onAddFiles={api.addFiles}
            canAdd={!uploading}
          />
          {uploadBar}
          {briefCard}
          {player}
          {timeline}
          {rangeBar}
          {captureBar}
          <div className="v-desktop-actions">
            <button type="button" className="btn" onClick={startRange} disabled={Boolean(rangePick)}>
              選一段留意見
            </button>
            {canManageReview && reviewOnline && (
              <button type="button" className="btn" onClick={() => setSummaryOpen(true)}>
                審片摘要
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => setMore(true)}>
              更多
            </button>
          </div>
        </section>
        <aside className="v-desktop-side">
          <header className="v-side-head">
            修改建議 {videoComments.length}
            <em>·</em> 待處理 {openCount}
          </header>
          {discussion}
        </aside>
        {sheets}
      </div>
      </div>
    );
  }

  return (
    <div
      className="m-app v-app"
      style={{
        ["--m-peek" as string]: "52px",
        ["--m-status" as string]: rangePick && !draft ? "48px" : "0px",
        ["--m-compose" as string]: `${composeInset}px`,
      }}
    >
      <header className="m-top">
        <button type="button" className="m-home" onClick={api.goHome} aria-label="回到列表">
          <span className="m-home-dot" />
        </button>
        <input className="m-title" value={room.title} onChange={(e) => api.setTitle(e.target.value)} aria-label="影片名稱" />
        {api.saveState !== "idle" && (
          <span className={`save-status save-${api.saveState}`}>
            {api.saveState === "saving" ? "儲存中…" : api.saveState === "saved" ? "已儲存" : "儲存失敗"}
          </span>
        )}
        {presence.status && (
          <span
            className={`m-presence is-${presence.status}`}
            title={presence.status === "online" ? `${presence.peers} 人同時在線` : "本機模式"}
          />
        )}
        <button type="button" className="m-share" onClick={api.openShare}>
          分享
        </button>
      </header>

      <VideoVersionSelector
        versions={room.versions}
        currentId={version.id}
        onSelect={switchVersion}
        onAddFiles={api.addFiles}
        canAdd={!uploading}
      />

      <div className="v-stage-area">
        {uploadBar}
        {briefCard}
        {player}
        {timeline}
        {captureBar}
      </div>

      <div className="m-bottom">
        <DragSheet
          snap={snap}
          onSnap={setSnap}
          viewportHeight={viewportHeight}
          handle={
            <span className="m-sheet-summary">
              修改建議 {videoComments.length}
              <em>·</em>
              待處理 {openCount}
            </span>
          }
        >
          {discussion}
        </DragSheet>

        {rangeBar}

        <nav className="m-toolbar m-toolbar-4" aria-label="主要操作">
          <button
            type="button"
            className={`m-tool ${!draft && !rangePick ? "is-on" : ""}`}
            onClick={() => {
              cancelDraft();
              api.selectPin(null);
              setSnap("peek");
            }}
          >
            <IconEye />
            <span>看</span>
          </button>
          <button
            type="button"
            className={`m-tool is-primary ${draft || rangePick ? "is-on" : ""}`}
            onClick={() => setActionOpen(true)}
            aria-haspopup="dialog"
          >
            <IconPen />
            <span>修改</span>
          </button>
          <button
            type="button"
            className="m-tool"
            onClick={() => setSnap((s) => (s === "peek" ? "half" : "peek"))}
          >
            <span className="m-tool-badge-wrap">
              <IconChat />
              {openCount > 0 && <span className="m-tool-badge">{openCount}</span>}
            </span>
            <span>討論</span>
          </button>
          <button type="button" className="m-tool" onClick={() => setMore(true)} aria-haspopup="dialog">
            <IconMore />
            <span>更多</span>
          </button>
        </nav>
      </div>

      {sheets}
    </div>
  );
}
