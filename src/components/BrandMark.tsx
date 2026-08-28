type Props = {
  compact?: boolean;
  className?: string;
};

/** Shared brand lockup used on the welcome and home screens. */
export function BrandMark({ compact = false, className = "" }: Props) {
  return (
    <span className={`brand-lockup${compact ? " is-compact" : ""}${className ? ` ${className}` : ""}`}>
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 36 36" fill="none">
          <path d="M9.5 7.5h14a5 5 0 0 1 5 5v7.75a5 5 0 0 1-5 5h-7.6L10 30v-4.75h-.5a5 5 0 0 1-5-5V12.5a5 5 0 0 1 5-5Z" />
          <path d="m12 17 3.25 3.25L23.5 12" />
        </svg>
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>對稿</strong>
          <small>Review together</small>
        </span>
      )}
    </span>
  );
}
