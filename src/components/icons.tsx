type P = { className?: string };

const base = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconEye = (p: P) => (
  <svg {...base} {...p} aria-hidden>
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

export const IconPin = (p: P) => (
  <svg {...base} {...p} aria-hidden>
    <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.4" />
  </svg>
);

export const IconPen = (p: P) => (
  <svg {...base} {...p} aria-hidden>
    <path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    <path d="M14.5 5.5 18.5 9.5" />
  </svg>
);

export const IconEraser = (p: P) => (
  <svg {...base} {...p} aria-hidden>
    <path d="M8.5 20H20" />
    <path d="M15.5 4.5 4.9 15.1a2 2 0 0 0 0 2.8l2.2 2.2a2 2 0 0 0 2.8 0L20.5 9.5a2 2 0 0 0 0-2.8l-2.2-2.2a2 2 0 0 0-2.8 0Z" />
  </svg>
);

export const IconChat = (p: P) => (
  <svg {...base} {...p} aria-hidden>
    <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9Z" />
  </svg>
);

export const IconMore = (p: P) => (
  <svg {...base} {...p} aria-hidden>
    <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);
