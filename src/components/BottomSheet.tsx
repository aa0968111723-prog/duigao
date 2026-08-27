import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type SheetSnap = "peek" | "half" | "full";

type DragSheetProps = {
  snap: SheetSnap;
  onSnap: (s: SheetSnap) => void;
  viewportHeight: number;
  peekHeight?: number;
  handle: ReactNode;
  children: ReactNode;
};

/**
 * The discussion sheet: peek / half / full, draggable by its handle. It lives
 * in the bottom stack above the toolbar, so expanding never hides the tools.
 */
export function DragSheet({
  snap,
  onSnap,
  viewportHeight,
  peekHeight = 52,
  handle,
  children,
}: DragSheetProps) {
  const heights: Record<SheetSnap, number> = {
    peek: peekHeight,
    half: Math.max(peekHeight, Math.round(viewportHeight * 0.42)),
    full: Math.max(peekHeight, Math.round(viewportHeight * 0.76)),
  };
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    start.current = { y: e.clientY, h: heights[snap] };
    setDragHeight(heights[snap]);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!start.current) return;
    const next = start.current.h - (e.clientY - start.current.y);
    setDragHeight(Math.min(heights.full, Math.max(heights.peek, next)));
  };

  const onPointerUp = () => {
    if (!start.current) return;
    const current = dragHeight ?? heights[snap];
    const moved = Math.abs(current - start.current.h);
    start.current = null;
    setDragHeight(null);
    if (moved < 6) {
      onSnap(snap === "peek" ? "half" : snap === "half" ? "full" : "peek");
      return;
    }
    const nearest = (["peek", "half", "full"] as SheetSnap[]).reduce((best, key) =>
      Math.abs(heights[key] - current) < Math.abs(heights[best] - current) ? key : best,
    );
    onSnap(nearest);
  };

  const height = dragHeight ?? heights[snap];

  return (
    <section
      className={`m-sheet m-sheet-${snap} ${dragHeight != null ? "is-dragging" : ""}`}
      style={{ height }}
      aria-label="討論與修改清單"
    >
      <div
        className="m-sheet-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="m-grip" />
        {handle}
      </div>
      <div className="m-sheet-body">{children}</div>
    </section>
  );
}

type ModalSheetProps = {
  title?: string;
  onClose: () => void;
  /** When false a backdrop tap is ignored, so half-typed feedback is never lost. */
  dismissible?: boolean;
  action?: ReactNode;
  /** Screen space the sheet takes, keyboard included, so the poster can refit. */
  onHeight?: (px: number) => void;
  children: ReactNode;
};

/** A one-task sheet that slides over the poster: compose, share, compare. */
export function ModalSheet({ title, onClose, dismissible = true, action, onHeight, children }: ModalSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!onHeight) return;
    const el = panelRef.current;
    if (!el) return;
    const measure = () => onHeight(Math.round(window.innerHeight - el.getBoundingClientRect().top));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const vv = window.visualViewport;
    window.addEventListener("resize", measure);
    vv?.addEventListener("resize", measure);
    vv?.addEventListener("scroll", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      vv?.removeEventListener("resize", measure);
      vv?.removeEventListener("scroll", measure);
    };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // modal 是最內層：Escape 一律由它消費並標記，外層不得再關一件事。
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="m-scrim" onPointerDown={() => dismissible && onClose()}>
      <div ref={panelRef} className="m-modal" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="m-modal-head">
          <span className="m-grip" />
          <div className="m-modal-title-row">
            {title && <h2 className="m-modal-title">{title}</h2>}
            <button type="button" className="m-close" onClick={onClose}>
              關閉
            </button>
          </div>
        </div>
        <div className="m-modal-body">{children}</div>
        {action && <div className="m-modal-action">{action}</div>}
      </div>
    </div>
  );
}
