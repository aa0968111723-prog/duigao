# Claude 裁決 — PR-03（語音房 LiveKit）Grok round

日期：2026-08-28 ｜ PR #64 ｜ Grok verdict MUST_FIX（F1–F5 blocking）

| # | Grok 判定 | 裁決 | 處置 |
|---|---|---|---|
| F1 | high：開麥失敗不 disconnect；join 無世代 — 幽靈連線 | **接受** | liveVoice 開麥失敗即收線上拋；useVoiceRoom joinSeq 世代，任何 await 後過期即自收退場 |
| F2 | high：TTL 重連窗不看 leave；舊 Room listener 未拆 | **接受** | scheduleTokenRefresh 全程驗世代（三個檢查點）；disconnect() 一律 removeAllListeners |
| F3 | high：**遠端音軌從未 attach — 聽不到聲音** | **接受（本輪最有價值）** | TrackSubscribed → attach 隱藏 audio 元素進 DOM；unsubscribe/斷線全 detach 清場 |
| F4 | medium：join 重入鎖是 async state，連點雙開 | **接受** | joiningRef 同步鎖＋finally 釋放 |
| F5 | medium：session 生命週期空洞（空場殘影、雙 live、無人 end） | **接受** | join 收斂最舊 live；自建非最舊即自結；連線失敗自結＋補 left_at；最後一人離開且有權限即 end；「進行中」顯示以活躍參與者為準（無權限 end 時的誠實兜底） |
| F6 | low：假 wss 斷言弱 | **接受** | 加嚴：無離開鈕＋join 可重試＋不留空場斷言 |

## 殘餘（誠實記錄）

- 真實裝置的雙人通話（回音消除、藍牙路由、iOS Safari 手勢）需真機
  驗收 — harness 只能驗 token 契約與 UI 誠實性；LiveKit 真連線的雙人
  smoke 需在使用者環境跑（見 PR body 的部署步驟）。
- reviewer 是最後一人離開時無權 end session — 以顯示規則（活躍參與者
  =0 不顯示進行中）兜底，DB 列由下一個 can_manage 動作或下場 join 收斂。

## 本機驗證限制

共機（另一 agent 併行跑 planform Playwright，CPU 65-74%）使 multi-branch
journey 死於既有 plan-editor 負載競態（src=main A/B 同敗）— CI 為準。
unit 79/79、build 綠、tsc 0 於本機完成。

## 追記（#65 合併前的 e2e 斷言修訂）

CI 診斷（request tail：participants POST → voice-token POST → left_at
PATCH → session end PATCH）證實 join 全鏈正確、F5 失敗清場如設計運作 —
舊 e2e 斷言在等一個「live session 存在」的狀態，而那正是 F5 應該清掉的。
斷言改為驗證清場終態：誠實錯誤文案、session 曾落地（total>=1）、
live=0 且無未離場參與者、無離開鈕且 join 可重試。
