# WB00 Grok round 裁決

Grok verdict：MUST_FIX（F1-F4/F6/F8 blocking、F5/F7 non-blocking）。
本輪審的是文件本身 — 全部裁決已回寫進交付物，此處記錄判定：

- **F1（ADR-013 證據過時＋檢查點可 game）｜接受，已修**：xyflow issue
  引用撤回並在 ADR 內明示（#5066 已關/屬 v10、#5475 已修）；決策理由
  重寫為誠實版（差距比原稿窄）；檢查點改「五項全過、真機唯一證據、
  修補窗一次七天、到期任一不過即無條件啟動 spike」。
- **F2（operations 非原子＋undo 整列還原風險）｜接受，已修**：0023 加
  op_id unique（重試冪等）＋field_mask＋mask 限定 before/after；undo
  永不整列還原、走 OCC；兩種非原子缺口明示取捨。ADR-014 同步修訂。
- **F3（tombstone 讀側漏改＋UPDATE echo 復活）｜接受，已修**：migration
  計畫改為六條讀路逐一列舉（含 patch 管線把 tombstone UPDATE 轉
  node-delete、get_whiteboard_context 過濾、IDB reconcile、e2e mock）；
  soft-delete 帶 version 走 OCC；同 migration revoke REST DELETE；
  「行為切換非獨立可回滾」誠實化＋部署順序明訂。
- **F4（migration spec 缺件）｜接受，已修**：touch_whiteboard_edge 函式
  全文入計畫；handle CHECK 補上；source_version_id 補 FK；NOT VALID→
  清理→VALIDATE 三步＋convalidated 探針；parent_group 環防護 trigger；
  0022-0024 publication/replica/回滾逐條明寫。
- **F5（z_index 慣例無不變式）｜接受，已修**：frame z<0、node z>=0 為
  DB CHECK；paint/hit 全序 (z_index, created_at, id) 三鍵入 ADR-014，
  render 與 hit-test 共用 util；group 不參與 paint order。
- **F6（Focus Mode 疊加規則缺席）｜接受，已修**：wireflow 新增疊加規則
  章 — z token 45、AssetAiFab 需 App 層抑制（WB02 對 App.tsx 的最小觸
  點，入 #71 衝突面）、history 五條規則（sheet 不 push、overlay 再
  push、Escape 順序）、keep-mounted 的 re-measure。
- **F7（稽核三條過陳述）｜接受，已修**：--kb 消費者清單修正；pinch-drag
  機制降 PARTIAL（WB02 以測試釘住）；P2P 整包路徑 cloud 房不可達 →
  [major]→[minor]。
- **F8（測試假綠面）｜接受，已修**：有效畫布量法、FAB count()===0、
  鍵盤斷言用 --kb 幾何、24 張視覺基準＋絕對容差、reviewer 兩態探針、
  tombstone 探針含 RPC。

殘餘（誠實記錄）：檢查點的真機量測依賴人工執行與錄影 — 無法 CI 化，
以 rounds/wb02 的證據檔案為審查物。
