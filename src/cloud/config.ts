/**
 * Cloud is opt-in via env. Only the PUBLISHABLE (anon) key is ever read on the
 * client, and no key is ever committed — deployment platforms inject both.
 *
 * A *development* build without these stays in local-only mode (IndexedDB +
 * PeerJS), exactly as before. A *production* build without them is a broken
 * deployment, not a mode: share links there could only ever be legacy
 * host-must-stay-online URLs, so the app says so instead of pretending a
 * permanent share link exists (PR #16).
 */
const env = import.meta.env as Record<string, string | undefined>;

export const SUPABASE_URL = (env.VITE_SUPABASE_URL ?? "").trim();
export const SUPABASE_PUBLISHABLE_KEY = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

export const isProductionBuild = Boolean(import.meta.env.PROD);

/** `missing` = nothing injected at all; `invalid` = injected but unusable. */
export type CloudConfigStatus = "ready" | "missing" | "invalid";

/** `your-project`, `<url>`, `changeme`… — a copied template, not a real value. */
const PLACEHOLDER = /^(your|<|change[-_]?me|todo|example|placeholder|xxx)/i;

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function inspect(): { status: CloudConfigStatus; issues: string[] } {
  const issues: string[] = [];

  if (!SUPABASE_URL && !SUPABASE_PUBLISHABLE_KEY) {
    return { status: "missing", issues: ["VITE_SUPABASE_URL 與 VITE_SUPABASE_PUBLISHABLE_KEY 都沒有注入"] };
  }

  if (!SUPABASE_URL) {
    issues.push("VITE_SUPABASE_URL 沒有注入");
  } else if (PLACEHOLDER.test(SUPABASE_URL)) {
    issues.push("VITE_SUPABASE_URL 仍是範本佔位值");
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(SUPABASE_URL);
    } catch {
      parsed = null;
    }
    if (!parsed) issues.push("VITE_SUPABASE_URL 不是合法網址");
    // http is allowed only for a local stack (`supabase start` serves
    // http://127.0.0.1:54321); anything else on the network must be https.
    else if (parsed.protocol !== "https:" && !isLocalHost(parsed.hostname))
      issues.push("VITE_SUPABASE_URL 必須是 https（本機 Supabase 才可用 http）");
  }

  if (!SUPABASE_PUBLISHABLE_KEY) {
    issues.push("VITE_SUPABASE_PUBLISHABLE_KEY 沒有注入");
  } else if (PLACEHOLDER.test(SUPABASE_PUBLISHABLE_KEY)) {
    issues.push("VITE_SUPABASE_PUBLISHABLE_KEY 仍是範本佔位值");
  } else if (SUPABASE_PUBLISHABLE_KEY.length < 20 || /\s/.test(SUPABASE_PUBLISHABLE_KEY)) {
    issues.push("VITE_SUPABASE_PUBLISHABLE_KEY 格式不像 publishable key");
  } else if (SUPABASE_PUBLISHABLE_KEY.startsWith("sb_secret_") || SUPABASE_PUBLISHABLE_KEY.includes("service_role")) {
    // A service-role key in the frontend would bypass every RLS policy.
    issues.push("VITE_SUPABASE_PUBLISHABLE_KEY 看起來是 service-role key，前端不可使用");
  }

  return { status: issues.length ? "invalid" : "ready", issues };
}

const report = inspect();

export const cloudConfigStatus: CloudConfigStatus = report.status;
export const cloudConfigIssues: readonly string[] = report.issues;
export const isCloudConfigured = report.status === "ready";

/**
 * A production deployment that cannot host cloud rooms. The UI must never
 * report "分享連結已建立" in this state — see ShareSheet / App.openShare.
 */
export const isCloudDeploymentBroken = isProductionBuild && !isCloudConfigured;

if (isCloudDeploymentBroken) {
  // Deployment readiness is invisible in the UI until someone taps 分享; this
  // makes a mis-provisioned build obvious in the console the moment it loads.
  console.error(
    "[duigao] cloud 未就緒，永久分享連結無法建立。請在部署平台設定 VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY 後重新 build：",
    report.issues.join("；"),
  );
}
