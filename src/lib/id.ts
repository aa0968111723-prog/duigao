export function uid(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function roomCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * A v4 UUID on browsers that do not have `crypto.randomUUID`.
 *
 * `crypto.randomUUID` is a secure-context API added in Chrome 92, Firefox 95
 * and Safari 15.4. The LINE in-app browser on an older Android WebView, an
 * iPhone still on iOS 15.0–15.3, and any page opened over plain http all reach
 * this app with `crypto.randomUUID` undefined — and the id is not optional:
 * `versions.id`, `room_branches.id` and friends are `uuid` columns, so `uid()`'s
 * short code is not a substitute.
 *
 * Calling it must never throw. A thrown id generator inside an upload handler
 * is invisible to the person holding the phone: the button simply stops doing
 * anything, which is exactly the failure this replaces.
 */
export function uuid(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      /* fall through: a locked-down WebView can define it and still refuse */
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  // RFC 4122 §4.4: version 4, variant 10xx. Postgres rejects anything else.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) hex.push(bytes[i].toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
