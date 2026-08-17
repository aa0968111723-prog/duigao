import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "info" | "success" | "error";
export type ToastAction = { label: string; onClick: () => void };
export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
};

type ShowOptions = {
  tone?: ToastTone;
  action?: ToastAction;
  duration?: number;
};

const MAX_VISIBLE = 3;
let counter = 0;

/**
 * Minimal toast/feedback store. Keeps the newest few messages, auto-dismisses
 * each after a timeout (longer when it carries an Undo action so there is time
 * to react), and cleans up its timers on unmount.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, opts: ShowOptions = {}) => {
      const id = `toast-${++counter}`;
      const tone = opts.tone ?? "info";
      const action = opts.action;
      const duration = opts.duration ?? (action ? 6000 : 2600);
      setToasts((list) => [...list, { id, message, tone, action }].slice(-MAX_VISIBLE));
      const timer = window.setTimeout(() => dismiss(id), duration);
      timers.current.set(id, timer);
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const timersMap = timers.current;
    return () => {
      timersMap.forEach((timer) => clearTimeout(timer));
      timersMap.clear();
    };
  }, []);

  return { toasts, showToast, dismiss };
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.action!.onClick();
                onDismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-close" aria-label="關閉提示" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
