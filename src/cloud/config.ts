/**
 * Cloud is opt-in via env. When these are absent the whole app stays in
 * local-only mode (IndexedDB + PeerJS), exactly as before — no white screen.
 * Only the PUBLISHABLE (anon) key is ever read on the client.
 */
const env = import.meta.env as Record<string, string | undefined>;

export const SUPABASE_URL = (env.VITE_SUPABASE_URL ?? "").trim();
export const SUPABASE_PUBLISHABLE_KEY = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

export const isCloudConfigured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
