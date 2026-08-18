import type { SupabaseClient } from "@supabase/supabase-js";
import { CloudError } from "./errors";

/**
 * Guarantees an authenticated (anonymous) session and returns the user id.
 * Anonymous auth keeps the "type a name, join a room" UX — the user never sees
 * a sign-up form.
 */
export async function ensureSession(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (data.session?.user) return data.session.user.id;
  const { data: signed, error } = await supabase.auth.signInAnonymously();
  if (error || !signed.user) {
    throw new CloudError(error?.message ?? "anonymous sign-in failed", "auth");
  }
  return signed.user.id;
}
