import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, isCloudConfigured } from "./config";

let client: SupabaseClient | null = null;

/** The shared Supabase client, or null when cloud is not configured. */
export function getSupabase(): SupabaseClient | null {
  if (!isCloudConfigured) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: "duigao.supabase.auth",
      },
    });
  }
  return client;
}
