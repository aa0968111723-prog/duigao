# Claude 裁決 — PR-08b（離線矩陣＋死區懸掛修復）Grok round

日期：2026-08-28 ｜ Grok verdict **PASS**（3 findings 皆 non-blocking）

| # | Grok 判定 | 裁決 | 處置 |
|---|---|---|---|
| F1 | medium：DEV StrictMode updater 重跑雙發；晚到失敗可把 acked 打回 failed | **接受（守衛）** | 完成回呼加「acked 永不降級」；prod 單發＋duplicate-key 本就安全 |
| F2 | medium：online flush 輪的慢 3G >12s 成功寫入 → 誠實 failed（不再自動補） | **接受為界限** | 這正是「上限一次」的語意 — 快照對帳或手動重試接手；無資料遺失（列已在） |
| F3 | low：真死區 onLine 常駐 true、恢復無 online 事件 → 兩次 abort 後停在 failed 等手動 | **接受為界限** | 誠實 failed＋按鈕即設計行為；無限自動重試才是反面 |

## 本輪的真發現（e2e 抓到的產品缺陷，已修）

1. 死區 fetch 懸掛而非拒絕 → insert 無 deadline = outbox 永卡 sending。
2. 回網無自癒 → failed ghost 需要手動逐則重試。

修復語意：abortSignal 12s；同 owner（outbox）內的有界補送（每輪一次、
online 事件開新輪）；id 冪等使任何重複=duplicate-key=成功。

## 回歸

collab e2e 43/43（矩陣 5 檢查）；unit 79/79；multi-branch 18＋26；
video 165/165；share 72/72；gate PASS。
