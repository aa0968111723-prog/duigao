# Round: ci-red-fix — video E2E 全域 fault 注入 race

## 背景
main HEAD (f327a70) CI 紅燈。run 33080577556 與 33079054174 皆敗於
video-flow「23. metadata 寫入失敗後 video/poster object 皆清乾淨」。
本機重現：閒置時通過、6×CPU burner 下必敗（與 2-core CI runner 一致）。

## 根因主張
測試以全域 faults.versionInsert / faults.assetDelete 注入失敗，但武裝時
前面情境（取消上傳、上傳失敗）的非同步清理 DELETE / versions POST 仍在
飛行中，慢機器上 straggler 搶先消耗注入 → 斷言變 race。

## 修法（diff 在 branch fix/video-e2e-fault-race，只動測試 harness）
1. mock-supabase.mjs：room-scoped 注入鏈（armed → 下一個 create_room 的房
   → 該房第一個 versions POST 500 一次並記住 video_path → 含該路徑的第一
   個 DELETE 500 一次並計數）。
2. video-flow.mjs：改用上述注入；waitForTimeout(500) 改為可觀察終態輪詢
   （fault consumed + retry cleared + no orphans，上限 15s）；斷言加入
   faultCount===1 確保注入真的發生過。

## 請審查
- 修法是否真的消除 race（而非把測試放寬）？注入鏈有沒有新的競態窗口？
- 是否誤刪或弱化了原本要驗證的產品行為（removeQuietly retry 清理孤兒）？
- 產品碼是否其實存在真 bug 被這個測試掩蓋？
- 15s 輪詢上限與斷言組合是否可能假綠？
