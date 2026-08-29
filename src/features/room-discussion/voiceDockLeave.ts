/**
 * V-04: Leave stays available while the session is still ours.
 *
 * Accepts dock state (`live`) or truthful phase (`connected` | `reconnecting`).
 * Nine-state maps `reconnecting` → dock `connecting`, so the dock must read
 * `phase` — not `state` — or Leave disappears during token refresh.
 *
 * V-07 still mutes + disconnects before entering `reconnecting`.
 */
export function voiceDockShowsLeave(state: string): boolean {
  return state === "live" || state === "connected" || state === "reconnecting";
}
