-- 0026: whiteboard freehand 筆畫詞彙（WB03）
--
-- node_type CHECK 擴充 'freehand'。筆畫資料進 content.points（相對節點
-- 左上的 [x,y][]，節點 x/y/width/height 是外接框）— 不開新表：筆畫是
-- 節點的一種，搬動/刪除/undo/tombstone/RLS 全沿用 whiteboard_nodes。
--
-- Re-runnable：drop if exists 後重建。0014 重放只在 create table 時內聯
-- 此 CHECK（表已存在＝no-op），不會把 'freehand' 洗掉 — probe 驗證。
alter table public.whiteboard_nodes
  drop constraint if exists whiteboard_nodes_node_type_check;
alter table public.whiteboard_nodes
  add constraint whiteboard_nodes_node_type_check check (node_type in (
    'text', 'image', 'room_content', 'flow', 'mindmap', 'decision',
    'poll', 'link', 'group', 'ai_result', 'freehand'
  ));
