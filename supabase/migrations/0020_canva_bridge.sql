-- 0020 — Canva 文宣工作面（PR-05 第一階段）：OAuth 連結狀態的伺服端存放。
--
-- 為什麼是兩張「client 完全碰不到」的表：
--   Canva Connect 的 access/refresh token 是使用者級 credential。它們只被
--   canva-bridge edge function（service role）讀寫；瀏覽器端連「表存在」都
--   感覺不到 — RLS 開著、零 policy、對 anon/authenticated 全面 revoke。
--   client 想知道「我連結了嗎」只能問 bridge 的 status 動作（回布林，
--   永不回 token）。
--
-- canva_oauth_states：OAuth authorization code flow 的 state↔PKCE verifier
-- 對照。一次性（callback 消費即刪）、短命（bridge 在發新 state 時清 15
-- 分鐘前的舊列）。

create table if not exists public.canva_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  canva_user_display text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.canva_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  code_verifier text not null,
  created_at timestamptz not null default now()
);

alter table public.canva_connections enable row level security;
alter table public.canva_oauth_states enable row level security;

-- 零 policy＝service role 專用。再把表層 grant 也收掉，讓「RLS 誤關」
-- 這種第二層事故也到不了 token（防禦縱深，與 0014 的 anon revoke 同理）。
revoke all on public.canva_connections from anon, authenticated;
revoke all on public.canva_oauth_states from anon, authenticated;
