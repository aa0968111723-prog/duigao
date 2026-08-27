-- ---------------------------------------------------------------------------
-- 0019 — AI 提案套用的稽核事件（PR-04 剩餘，pr00 audit F8 的承諾）。
--
-- 0014 的 collaboration_audit_events 只有三種 trigger 寫入的事件型別，
-- 且 authenticated 只有 SELECT。AI 套用（人按「套用」後的永久變更）需要
-- 一條可查證的機器紀錄 — 討論串裡的「已套用 AI 提案」訊息是給人看的，
-- 這張表是給稽核看的。
--
-- 設計約束：
--  * client 只能寫 'ai_proposal_applied' 一種型別，且 actor 必須是自己、
--    房間必須是自己所屬 — trigger 寫入的三種型別維持不可偽造
--    （INSERT policy 的 with check 排除它們）。
--  * 不開 UPDATE / DELETE：稽核列 append-only。
--  * payload 只存 proposal 的 id / type / label（呈現層事實）；
--    不存 proposal 原始 payload — 那可能含使用者內容，稽核不需要。
--
-- 冪等：drop … if exists 之後重建；0014 replay（create table if not
-- exists＋grant select）不會復活舊 CHECK、也不會撤銷本檔的 insert grant。
-- ---------------------------------------------------------------------------

alter table public.collaboration_audit_events
  drop constraint if exists collaboration_audit_events_event_type_check;
alter table public.collaboration_audit_events
  add constraint collaboration_audit_events_event_type_check
  check (event_type in (
    'whiteboard_created', 'whiteboard_archived', 'decision_finalized',
    'ai_proposal_applied'
  ));

drop policy if exists collaboration_audit_insert_ai on public.collaboration_audit_events;
create policy collaboration_audit_insert_ai on public.collaboration_audit_events
  for insert to authenticated
  with check (
    event_type = 'ai_proposal_applied'
    and public.is_room_member(room_id)
    and actor_user_id = auth.uid()
  );

grant insert on public.collaboration_audit_events to authenticated;

-- append-only 是權限層事實，不只是「沒有 policy 所以 0 列生效」：
-- 明確拒絕 update / delete（0001 時代的廣域 grant 防禦縱深）。
revoke update, delete on public.collaboration_audit_events from authenticated;
