-- ---------------------------------------------------------------------------
-- 0027 — 設計知識庫（PR-DI-01）
--
-- 為什麼需要新表：全庫沒有任何知識庫語意的表（BASELINE_AUDIT §3）。設計原則
-- （「內文對比至少 4.5:1」）本質上是**跨房共用**的，但這個 schema 的授權最上層
-- 就是 room + room_members，所有 RLS 都是 is_room_member(room_id) —— 跨房知識
-- 在現有骨架下沒有位置。
--
-- 兩段式授權（handoff H-2）：
--   * project_specific IS NULL  = 通用設計知識
--       讀：所有 authenticated（設計原則不是機密，且每個房間都需要它）
--       寫：**沒有 client 政策** —— 只能由 migration seed 或 service_role 寫入。
--           理由：讓任何登入者都能寫全域知識，等於讓任何人污染所有房間的
--           AI 判斷依據。library_assets 的 scope='shared' 就是這種過粗的
--           粒度（0016:61-74），這裡不重蹈。
--   * project_specific = <room_id> = 這個房間的自有規範（品牌色、字體…）
--       讀：is_room_member(room_id)
--       寫：can_manage_media(room_id)（與房內其他內容一致）
--
-- 若日後導入 organization / workspace 層，project_specific 改指向 org id
-- 只需要改這一個欄位的 FK 與兩條 RLS 條件（刻意做成單一欄位）。
--
-- 不做的事（誠實邊界）：
--   * 沒有 pgvector。asset_embeddings 是 jsonb array 且零讀寫者（死碼），
--     本檔不假裝有語意檢索 —— 檢索沿用既有 lexical 打分，中文召回率未驗證。
--   * 不擴充 collaboration_audit_events 的 event_type：知識被引用的稽核屬
--     PR-DI-02（分析引擎產生提案時才有引用可記）。
--
-- 冪等：create ... if not exists ＋ drop policy if exists 後重建。
-- ---------------------------------------------------------------------------

-- 規則裡不能有「只有空白」的項目。
--
-- 用 immutable 函式而不是 array_position：`array[' ']` 的 cardinality 是 1、
-- 也找不到精確的空字串，所以舊的 CHECK 放行了它 —— 與 array_length 回 NULL
-- 是同一類的洞（都是對抗審查實測到的）。client 的 stringList 會 trim 後退件，
-- 但直接打 REST 的不會經過 client。
create or replace function public.design_knowledge_rules_ok(p_rules text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(p_rules) between 1 and 20
     and not exists (
       -- btrim 預設**只去半形空格** —— tab、換行與不斷行空白都留得下來，
       -- probe 實測 array[E'\t'] 會過關。字元集要明寫出來。
       select 1 from unnest(p_rules) as r
        where r is null or btrim(r, E' \t\n\r\f' || chr(160) || chr(9) || chr(11)) = ''
     );
$$;

create table if not exists public.design_knowledge (
  id uuid primary key default extensions.gen_random_uuid(),

  category text not null check (category in (
    'layout', 'typography', 'color', 'branding', 'accessibility',
    'mobile-ux', 'tablet-ux', 'web-ui', 'print', 'social-media',
    'video', 'presentation', 'marketing', '3d-space',
    'project-rules', 'brand-rules'
  )),

  title text not null check (char_length(title) between 1 and 160),
  summary text not null check (char_length(summary) between 1 and 800),

  -- rules 是這張表的核心：沒有可執行規則的條目不算知識，
  -- 所以 CHECK 要求至少一條、且每條不得為空字串。
  -- 見上面 design_knowledge_rules_ok 的說明：array_length 對空陣列回 NULL
  -- 而 CHECK 遇到 NULL 一律放行；array_position 又抓不到「只有空白」。
  -- 兩個洞都是實測出來的，所以判斷集中在一個 immutable 函式裡。
  rules text[] not null check (public.design_knowledge_rules_ok(rules)),
  exceptions text[] not null default '{}',
  applicable_contexts text[] not null default '{}',

  source_url text check (source_url is null or source_url like 'https://%'),
  source_title text,
  source_type text not null default 'unknown' check (source_type in (
    'official-spec', 'vendor-doc', 'framework-doc', 'article', 'unknown'
  )),
  publisher text,
  retrieved_at timestamptz,
  reviewed_at timestamptz,

  version integer not null default 1 check (version >= 1),

  trust_level text not null default 'unverified' check (trust_level in (
    'project', 'approved', 'reviewed', 'machine', 'unverified'
  )),
  status text not null default 'draft' check (status in (
    'draft', 'machine-researched', 'human-reviewed', 'approved', 'deprecated'
  )),

  -- 專案自有規範指向房間；null = 通用知識
  project_specific uuid references public.rooms (id) on delete cascade,

  -- 內容雜湊：唯一索引的權威來源。**由 trigger 計算**，呼叫端給什麼都會被
  -- 覆蓋 —— 否則寫入端可以宣稱「我跟那條已審查的知識內容相同」來繞過判重，
  -- 或反過來對同一份內容給不同雜湊塞進兩列。
  content_hash text not null check (char_length(content_hash) between 4 and 128),

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 機器研究的結果**不得自稱**已核准或專案規範。
  -- schema.ts 的 parseKnowledgeEntry 在 client 端做同一件事；這裡是
  -- 資料庫層的第二道 —— client 驗證擋得住誠實的呼叫端，擋不住直接打 REST 的。
  constraint design_knowledge_machine_not_approved check (
    status <> 'machine-researched'
    or trust_level not in ('approved', 'project')
  ),

  -- trust_level='project' 必須真的屬於某個專案
  constraint design_knowledge_project_trust_needs_room check (
    trust_level <> 'project' or project_specific is not null
  ),

  -- 高信任等級必須留下審查痕跡。
  --
  -- 誠實說明這條擋得住什麼、擋不住什麼：資料庫**無法**驗證一條知識到底是
  -- 人審過的還是模型生的 —— 那是 client 的 provenance 負責的
  -- （schema.ts 的 parseKnowledgeEntry）。舊版的
  -- design_knowledge_machine_not_approved 只在 status='machine-researched'
  -- 時發動，而 status 同樣由寫入端自己填，所以直接打 REST 的人只要改成
  -- status='approved' 就整條繞過 —— 對抗審查指出這是「名實不符的第二道門」，
  -- 屬實。
  --
  -- 這條做得到的是：讓「宣稱已核准」必須同時留下 reviewed_at，
  -- 使高信任等級的條目在稽核時至少有一個可以對照的時間點，而不是零成本。
  constraint design_knowledge_high_trust_needs_review check (
    trust_level not in ('approved', 'project') or reviewed_at is not null
  )
);

-- 同一個範圍內，同樣的內容不重複收錄。
-- 通用知識（project_specific is null）與專案規範分開判重。
create unique index if not exists idx_design_knowledge_global_hash
  on public.design_knowledge (category, content_hash)
  where project_specific is null;

create unique index if not exists idx_design_knowledge_project_hash
  on public.design_knowledge (project_specific, category, content_hash)
  where project_specific is not null;

-- 檢索路徑：先照 category 收斂，再由應用層做 lexical 打分
create index if not exists idx_design_knowledge_category
  on public.design_knowledge (category, status);

create index if not exists idx_design_knowledge_project
  on public.design_knowledge (project_specific)
  where project_specific is not null;

-- content_hash 由資料庫算，不接受呼叫端提供。
--
-- 正規化用**長度前綴**而非分隔字元：任何分隔字元都能被嵌進標題或規則裡，
-- 構造出「不同內容、相同輸入串」的碰撞。`3:abc` 這種編碼沒有這個面。
create or replace function public.design_knowledge_content_hash(
  p_title text, p_summary text, p_rules text[]
) returns text
language sql
immutable
set search_path = ''
as $$
  select md5(
    length(p_title) || ':' || p_title
    || length(p_summary) || ':' || p_summary
    || cardinality(p_rules) || ':'
    || coalesce(
         (select string_agg(length(r) || ':' || r, '' order by ord)
          from unnest(p_rules) with ordinality as t(r, ord)),
         ''
       )
  );
$$;

create or replace function public.set_design_knowledge_hash()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.content_hash = public.design_knowledge_content_hash(new.title, new.summary, new.rules);
  return new;
end;
$$;

drop trigger if exists trg_set_design_knowledge_hash on public.design_knowledge;
create trigger trg_set_design_knowledge_hash
  before insert or update on public.design_knowledge
  for each row execute function public.set_design_knowledge_hash();

-- updated_at 由 trigger 維護（與 0014 的 touch_* 同慣例）
create or replace function public.touch_design_knowledge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  -- version 只進不退：內容改了就是新版本，不允許呼叫端把版本倒回去
  if new.version < old.version then
    raise exception 'stale-write' using hint = '這條知識剛被別人更新過，請重新載入。';
  end if;
  if new.version = old.version then
    new.version = old.version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_touch_design_knowledge on public.design_knowledge;
create trigger trg_touch_design_knowledge
  before update on public.design_knowledge
  for each row execute function public.touch_design_knowledge();

alter table public.design_knowledge enable row level security;

-- 讀：通用知識所有登入者可讀；專案規範只有房內成員可讀
drop policy if exists design_knowledge_select on public.design_knowledge;
create policy design_knowledge_select on public.design_knowledge
  for select to authenticated
  using (
    project_specific is null
    or public.is_room_member(project_specific)
  );

-- 寫：**只有專案規範**能由 client 寫。通用知識沒有 client 政策，
-- 只能由 migration seed 或 service_role 寫入（見檔頭的理由）。
drop policy if exists design_knowledge_insert_project on public.design_knowledge;
create policy design_knowledge_insert_project on public.design_knowledge
  for insert to authenticated
  with check (
    project_specific is not null
    and public.can_manage_media(project_specific)
    and created_by = (select auth.uid())
  );

drop policy if exists design_knowledge_update_project on public.design_knowledge;
create policy design_knowledge_update_project on public.design_knowledge
  for update to authenticated
  using (project_specific is not null and public.can_manage_media(project_specific))
  with check (project_specific is not null and public.can_manage_media(project_specific));

drop policy if exists design_knowledge_delete_project on public.design_knowledge;
create policy design_knowledge_delete_project on public.design_knowledge
  for delete to authenticated
  using (project_specific is not null and public.can_manage_media(project_specific));

-- 權限：**先全部收回再逐項給**。
--
-- Supabase 的 default privileges 對 public schema 的新表是 `grant all to
-- anon, authenticated`，所以不先 revoke all，這張表一建立就帶著
-- TRUNCATE / REFERENCES / TRIGGER。**RLS 不管 TRUNCATE** ——
-- 也就是任何登入者都可以 `truncate public.design_knowledge` 把整個知識庫清空，
-- 而所有的 policy 一條都攔不住（migration probe 誠實化之後實測到的）。
revoke all on public.design_knowledge from anon, authenticated;
grant select, insert, update, delete on public.design_knowledge to authenticated;

-- service_role（edge function 與 migration seed）需要完整權限。
-- 正式 Supabase 有預設授權，但依賴預設值就是依賴一個沒有寫下來的假設。
grant all on public.design_knowledge to service_role;

-- ---------------------------------------------------------------------------
-- Seed：通用設計知識（只放**可驗證**的規則）
--
-- 挑選原則：每一條都能對應到一個可以量測的檢查，而不是品味。
-- 「標題要有吸引力」不進來；「內文對比 ≥ 4.5:1」進來，因為程式算得出來。
-- 來源一律是官方規格，trust_level 為 approved（migration seed 等同人工審查）。
--
-- content_hash 不在這裡指定：由 trigger 從內容算出來。seed 與 client 走
-- 同一條路徑，所以「內容一樣就是同一條」在兩邊的定義一致。
-- ---------------------------------------------------------------------------

insert into public.design_knowledge
  (category, title, summary, rules, exceptions, applicable_contexts,
   source_url, source_title, source_type, publisher, trust_level, status,
   reviewed_at)
values
  ('accessibility',
   '內文與背景的對比至少 4.5:1',
   'WCAG 2.2 的 AA 等級要求一般大小文字與其背景的對比至少 4.5:1；大字（18pt 以上，或 14pt 粗體以上）可放寬到 3:1。',
   array[
     '一般內文與背景對比 ≥ 4.5:1',
     '大字（≥18pt 或 ≥14pt 粗體）與背景對比 ≥ 3:1',
     '純裝飾性文字與已停用的控制項不受此限'
   ],
   array['純裝飾圖形上的文字若有等價的替代文字，可另行評估'],
   array['poster', 'website', 'presentation', 'mobile', 'tablet'],
   'https://www.w3.org/TR/WCAG22/#contrast-minimum',
   'WCAG 2.2 — Contrast (Minimum)',
   'official-spec', 'W3C', 'approved', 'approved', now()),

  ('accessibility',
   'UI 元件與圖形物件的對比至少 3:1',
   'WCAG 2.2 要求「使用者介面元件」與「理解內容所必需的圖形」相對於相鄰顏色的對比至少 3:1 —— 這包含按鈕邊框、輸入框邊界、圖示。',
   array[
     '按鈕、輸入框等控制項的邊界與周圍對比 ≥ 3:1',
     '傳達資訊的圖示與背景對比 ≥ 3:1',
     '只靠顏色區分狀態不合格，必須另有形狀或文字'
   ],
   array['純裝飾、不傳達資訊的圖形不受此限'],
   array['website', 'mobile', 'tablet'],
   'https://www.w3.org/TR/WCAG22/#non-text-contrast',
   'WCAG 2.2 — Non-text Contrast',
   'official-spec', 'W3C', 'approved', 'approved', now()),

  ('mobile-ux',
   '觸控目標至少 24×24 CSS px（建議 44×44）',
   'WCAG 2.2 新增的 Target Size (Minimum) 要求觸控目標至少 24×24 CSS px；Apple HIG 建議 44×44 pt，Material 建議 48×48 dp —— 兩者都比規格的下限寬鬆，是實務上的建議值。',
   array[
     '觸控目標的可點擊區域 ≥ 24×24 CSS px（規格下限）',
     '主要操作建議 ≥ 44×44（iOS）或 48×48（Android）',
     '相鄰目標之間要有足夠間距，避免誤觸'
   ],
   array['行內連結、由瀏覽器決定尺寸的原生控制項、有等價替代操作者'],
   array['mobile', 'tablet', 'website'],
   'https://www.w3.org/TR/WCAG22/#target-size-minimum',
   'WCAG 2.2 — Target Size (Minimum)',
   'official-spec', 'W3C', 'approved', 'approved', now()),

  ('mobile-ux',
   '尊重 prefers-reduced-motion',
   '使用者若在系統設定要求減少動態效果，網頁應停用非必要的動畫與視差效果。這不只是偏好 —— 對前庭功能障礙者，過度的動態可能造成不適。',
   array[
     '所有非必要動畫都要包在 @media (prefers-reduced-motion: reduce) 的例外裡',
     '自動播放的視差、滑動、縮放效果在 reduce 模式下停用',
     '保留必要的狀態轉換提示（但改用淡入淡出等低幅度效果）'
   ],
   array['對理解內容為必要的動畫（例如示範操作步驟）可保留，但要能暫停'],
   array['website', 'mobile', 'tablet'],
   'https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion',
   'MDN — prefers-reduced-motion',
   'vendor-doc', 'MDN', 'approved', 'approved', now()),

  ('typography',
   '行長與行高影響可讀性',
   '一般內文一行約 45–75 個西文字元（中文約 20–35 字）最易讀；行高建議為字級的 1.4–1.6 倍。過長的行讓眼睛回行時容易跳行，過窄的行則讓閱讀節奏斷裂。',
   array[
     '內文一行約 45–75 西文字元／20–35 中文字',
     '內文行高為字級的 1.4–1.6 倍',
     '標題可用較緊的行高（1.1–1.3），但不得讓上下行的字互相碰到'
   ],
   array['表格、程式碼、單行標籤不適用行長建議'],
   array['poster', 'website', 'presentation', 'print'],
   'https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html',
   'WCAG 2.2 — Understanding Visual Presentation',
   'official-spec', 'W3C', 'approved', 'approved', now()),

  ('layout',
   '視覺層級由大小、粗細、顏色與留白共同建立',
   '「層級不清楚」通常不是單一屬性的問題。同一組資訊若字級相同、字重相同、顏色相同，讀者就無法判斷先看什麼 —— 至少要有一個維度拉開差距。',
   array[
     '同一畫面的資訊分成 3–4 個層級即可，過多層級等於沒有層級',
     '相鄰層級之間至少有一個維度（字級／字重／顏色／留白）有明顯差距',
     '最重要的資訊要在視線起點（西方閱讀習慣為左上）或以尺寸取得優先權',
     '留白是層級工具，不是浪費 —— 群組之間的間距要大於群組內部'
   ],
   array['刻意的極簡設計可以只用留白建立層級，但仍須可辨識'],
   array['poster', 'presentation', 'website', 'social-media'],
   null, null, 'unknown', null, 'approved', 'approved', now()),

  ('social-media',
   '社群縮圖必須在小尺寸下仍可讀',
   '社群平台的動態牆會把圖大幅縮小顯示。在設計階段就要用縮圖尺寸檢查主標題是否還讀得出來 —— 這是「手機上看不懂」最常見的單一原因。',
   array[
     '主標題在寬度 150px 的縮圖下仍須可辨識',
     '關鍵資訊不要放在會被裁切的邊緣（各平台裁切比例不同）',
     '文字面積佔比過高會影響部分平台的觸及，設計時預留調整空間'
   ],
   array['僅用於印刷或大螢幕投影的稿件不適用'],
   array['social-media', 'poster'],
   null, null, 'unknown', null, 'approved', 'approved', now())
on conflict do nothing;
