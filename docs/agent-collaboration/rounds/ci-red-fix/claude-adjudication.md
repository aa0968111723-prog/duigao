# Adjudication: ci-red-fix

Grok session: 見 grok-findings.json（grok 1.0.5 / grok-4.6-build, read-only）。

| # | Finding | 裁決 | 處置 |
|---|---|---|---|
| F1 (medium) | 根因主張過強：主導 race 是 `.onboard-card` 也匹配「上傳中」卡 + 固定 500ms settle；straggler 吃全域 fault 是次要窗口 | **接受** | 等待錨點改為失敗文案（waitForFunction 含「失敗」）；commit message 與註解已改述根因為「進度卡 + 固定 settle 為主、straggler 為次」 |
| F2 (low) | `versionInsertNextRoom` 武裝到 create_room 之間存在 TOCTOU；被偷綁時結果是假紅非假綠 | **接受為已記錄殘餘風險** | 不改：此腳本武裝時僅剩單一 context；失敗模式是假紅（會被看見），非假綠。若未來多 context 並行再引入 generation token |
| F3 (positive) | 斷言比舊版嚴（強制注入發生 + retry 清孤兒）；但 `assetDeleteTargetPath===null` 語意是「注入已觸發」非「retry 完成」 | **接受** | 註解已修正：retry 成功的證據是 leaked.length===0 |

複驗：修正後 157/157（閒置）；前輪已證 6×CPU load 下新碼 157/157 ×2、舊碼 156/157。
無產品碼變更；removeQuietly retry 契約仍被強制驗證（F3）。
