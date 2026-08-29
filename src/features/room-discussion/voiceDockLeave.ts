/**
 * V-04: Leave stays available while the session is still ours.
 *
 * GAP-03 mutes + disconnects before `reconnecting`, so the mic is already
 * down. This stack may still be four-state (`live` only) until #98 lands;
 * `reconnecting` is accepted so the dock does not lose Leave on that merge.
 */
export function voiceDockShowsLeave(state: string): boolean {
  return state === "live" || state === "reconnecting";
}
