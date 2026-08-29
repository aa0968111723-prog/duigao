# WB01 Grok round 裁決

Grok verdict：MUST_FIX（F1-F4 blocking、F5-F8 non-blocking）。全部裁決：

- **F1（IDB 快照競態復活殭屍）｜接受，已修**：開板流程從「快照與雲端
  並發」改為「先快照、後雲端整替」序列 — replaceBoardGraph（整替＋
  墓碑過濾）永遠是最後一手；離線時快照仍在。e2e 新增「B 重開板殭屍
  不復活」真反例（46/46）。
- **F2（刪除不在 persist chain、版本簿記分歧）｜接受，已修**：刪除排進
  同節點的 nodePersistChain（先改後刪時 upsert 先落地、其 ack 推進
  lastAcked，刪除在 chain 內執行時刻讀 lastAcked）；佇列側刪除取代同
  節點未送 upsert（clearPendingEdit），version 也改讀 lastAcked。
- **F3（get_selected_board_context 漏濾）｜接受，已修**：0021 內重建第二
  條 AI 讀路加 deleted_at 過濾；mock 的兩個 context RPC 同步過濾；
  migrations 探針補「selected context 不含墓碑」。
- **F4（測試假綠面）｜接受，已修**：e2e 補雙分頁軟刪同步＋DB 軟刪斷言
  ＋重開板殭屍反例；探針補 selected-context/publication 成員資格（shim
  補建 publication — 先前 guard 跳過使成員資格不可測）/快照缺 edges。
  **副產物**：探針實抓 0024 CHECK 的三值邏輯洞（缺鍵→NULL→放行），
  已以 coalesce 修補 — Grok F8c 的方向相反但同點（原 CHECK 其實「靜默
  容忍」缺鍵，比「不容忍」更糟）。
- **F5（create/delete undo 無執行層）｜接受，誠實化**：operations.ts 與
  測試明文標注 create↔delete 的 inverse 是事實描述、執行層（softDelete/
  upsert 重建）屬 WB02/WB04；不再以 round-trip 措辭過度宣稱。
- **F6（undefined vs 缺 key、深比較）｜接受，已修**：diffMask 改結構相等
  （groupIds 等陣列不誤報）；applyMasked 對必填數值欄缺值保留現值。
  各補反例測試。
- **F7（messageId 遮蔽 board-node）｜接受，已修**：whiteboardId 優先權
  恢復最高；補 whiteboardId+messageId → board-node 測試。
- **F8（SQL 誠實記錄）｜接受，已記/已修**：(a) cycle trigger 併發缺口
  註解明記（READ COMMITTED 下非 serializable 保證；讀側深度上限兜底）；
  (b) 0023 WITH CHECK 對 service_role（BYPASSRLS）無效 — service 屬
  信任邊界，記錄即可；(c) 0024 缺鍵語意見 F4；(d) 0021 link_pair 註解
  改為與行為一致（清理正規化、validate 證明）。

## 殘餘

- cycle trigger 的並發環（兩 tx 各自看不到對方）：接受 — 讀側深度上限
  32 保證不無窮迴圈；serializable 隔離屬過度工程。
- op 執行層（undo 佈線）與 op 發射（persist 管線寫 op）在 WB02 落地。
