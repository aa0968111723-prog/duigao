import { useCallback, useEffect, useState } from "react";
import type { WorkspaceApi } from "../../components/api";
import { Viewer, type ViewerMetrics, type ZoomRequest } from "./Stage";
import {
  DEFAULT_VIEWER_TRANSFORM,
  sameTransform,
  type ViewerTransform,
  type ZoomPreset,
  zoomLabel,
} from "./viewerGeometry";

type Props = {
  api: WorkspaceApi;
  onClose: () => void;
};

/**
 * A focused, phone-first surface for inspecting one poster. The transform is
 * deliberately local to this component: the room shares annotations, never a
 * reviewer's personal zoom or pan position.
 */
export function ImmersiveViewer({ api, onClose }: Props) {
  const [transform, setTransform] = useState<ViewerTransform>(DEFAULT_VIEWER_TRANSFORM);
  const [metrics, setMetrics] = useState<ViewerMetrics | null>(null);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [zoomRequest, setZoomRequest] = useState<ZoomRequest | null>(null);

  const updateTransform = useCallback((next: ViewerTransform) => {
    setTransform((previous) => (sameTransform(previous, next) ? previous : next));
  }, []);

  const updateMetrics = useCallback((next: ViewerMetrics) => {
    setMetrics((previous) => {
      if (
        previous &&
        previous.box.w === next.box.w &&
        previous.box.h === next.box.h &&
        previous.frame.left === next.frame.left &&
        previous.frame.top === next.frame.top &&
        previous.frame.width === next.frame.width &&
        previous.frame.height === next.frame.height &&
        previous.natural.w === next.natural.w &&
        previous.natural.h === next.natural.h
      ) {
        return previous;
      }
      return next;
    });
  }, []);

  const requestZoom = (preset: ZoomPreset) => {
    setZoomRequest((previous) => ({ preset, nonce: (previous?.nonce ?? 0) + 1 }));
    setControlsVisible(true);
  };

  const startComment = () => {
    setShowAnnotations(true);
    setControlsVisible(true);
    api.selectPin(null);
    api.setTool("pin");
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const label = metrics ? zoomLabel(transform, metrics.frame, metrics.natural) : "Fit";
  const isCommenting = api.tool === "pin" && !api.draftPin;

  return (
    <div className="immersive-viewer" role="dialog" aria-modal="true" aria-label="文宣檢視器" data-testid="immersive-viewer">
      <div className={`immersive-controls ${controlsVisible ? "is-visible" : "is-hidden"}`}>
        <header className="immersive-head">
          <button type="button" className="immersive-back" onClick={onClose} aria-label="返回對稿" data-testid="viewer-close">
            <span aria-hidden>‹</span>
            <span>返回</span>
          </button>
          <span className="immersive-zoom" aria-live="polite" data-testid="zoom-status">
            {label}
          </span>
          <div className="immersive-head-actions">
            <button
              type="button"
              className={`immersive-control-btn ${!showAnnotations ? "is-on" : ""}`}
              onClick={() => setShowAnnotations((visible) => !visible)}
              aria-pressed={!showAnnotations}
              aria-label={showAnnotations ? "看純原稿，隱藏標記" : "顯示標記"}
              data-testid="viewer-clean-toggle"
            >
              {showAnnotations ? "純原稿" : "顯示標記"}
            </button>
            <button
              type="button"
              className={`immersive-control-btn immersive-comment-btn ${isCommenting ? "is-on" : ""}`}
              onClick={startComment}
              aria-pressed={isCommenting}
              data-testid="viewer-comment"
            >
              ＋ 留意見
            </button>
          </div>
        </header>

        {isCommenting && (
          <div className="immersive-comment-hint" role="status">
            點一下文宣位置留下修改建議
            <button type="button" onClick={() => api.setTool("pan")}>
              取消
            </button>
          </div>
        )}
      </div>

      <div className="immersive-stage">
        <Viewer
          api={api}
          compact
          zoomable
          transform={transform}
          onTransformChange={updateTransform}
          onMetricsChange={updateMetrics}
          zoomRequest={zoomRequest}
          focusPinId={api.selectedPinId}
          showAnnotations={showAnnotations}
          onTap={() => setControlsVisible((visible) => !visible)}
        />
      </div>

      <div className={`immersive-zoom-bar ${controlsVisible ? "is-visible" : "is-hidden"}`} aria-label="快速縮放">
        <button
          type="button"
          className={label === "Fit" ? "is-on" : ""}
          onClick={() => requestZoom("fit")}
          aria-pressed={label === "Fit"}
          data-testid="viewer-zoom-fit"
        >
          適合螢幕
        </button>
        <button
          type="button"
          className={label === "100%" ? "is-on" : ""}
          onClick={() => requestZoom("100")}
          aria-pressed={label === "100%"}
          data-testid="viewer-zoom-100"
        >
          100%
        </button>
        <button
          type="button"
          className={label === "200%" ? "is-on" : ""}
          onClick={() => requestZoom("200")}
          aria-pressed={label === "200%"}
          data-testid="viewer-zoom-200"
        >
          200%
        </button>
      </div>
    </div>
  );
}
