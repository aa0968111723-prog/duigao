import type { ReactNode } from "react";

type LiveRangeProps = {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  onBegin: () => void;
  onLive: (value: number) => void;
  onEnd: () => void;
};

/**
 * A slider whose drag only mutates in-memory state; it commits (persist + one
 * undo step) on release / blur. Keeps IndexedDB writes off the drag path.
 */
export function LiveRange({ label, value, min, max, step, ariaLabel, onBegin, onLive, onEnd }: LiveRangeProps) {
  return (
    <label className="proposal-field">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        onPointerDown={onBegin}
        onKeyDown={onBegin}
        onChange={(e) => onLive(Number(e.target.value))}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
        onKeyUp={onEnd}
        onBlur={onEnd}
      />
    </label>
  );
}

type LiveColorProps = {
  label: ReactNode;
  value: string;
  ariaLabel: string;
  onBegin: () => void;
  onLive: (value: string) => void;
  onEnd: () => void;
};

export function LiveColor({ label, value, ariaLabel, onBegin, onLive, onEnd }: LiveColorProps) {
  return (
    <label className="proposal-field proposal-field-inline">
      <span>{label}</span>
      <input
        type="color"
        value={value}
        aria-label={ariaLabel}
        onFocus={onBegin}
        onChange={(e) => onLive(e.target.value)}
        onBlur={onEnd}
      />
    </label>
  );
}
