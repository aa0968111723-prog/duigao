# FINDINGS_RULING — 對抗審查裁決

依任務書 §二十九，每一條稽核發現逐項裁決為
`accepted` / `partially-accepted` / `rejected-with-reason` / `deferred-with-owner`。

---

## 使用的工具（如實記錄）

`irm` 在本機**不存在**（`command not found`），**沒有冒充使用**。
實際使用 Claude Code 的 workflow 子代理，分兩層：

1. **稽核層**：7 個代理，各負責一個子系統（訊息核心、Realtime、RLS、語音、
   手機 UI、能力盤點、測試盲區），要求每條發現必須引用實際讀到的原始碼。
2. **對抗層**：每條發現派一個 verifier，**任務是推翻它**，不確定一律判
   refuted（預設 refuted=true）。

### 執行狀況（含失敗）

| 輪次 | 結果 |
|---|---|
| 稽核層第 1 輪 | 7 個代理，**6 個完成**、1 個（realtime-sync）因網路錯誤中止 |
| 對抗層第 1 輪 | 74 個 verifier，**全部因 `Unable to connect to API: Self-signed certificate detected` 中止** — 等於完全沒有驗證 |
| 對抗層第 2 輪（重跑） | **43 條取得裁決**（33 條未被推翻、10 條被推翻），其餘仍有網路失敗 |

**第 1 輪的失敗必須寫出來**：如果只看第一次的輸出，會拿到 74 條「稽核發現」
而完全沒有驗證，卻很容易被當成已確認的缺陷清單。

---

## 一、accepted — 已修，且有真環境或全 repo 交叉證據

| 發現 | 裁決 | 證據 |
|---|---|---|
| 任何成員可用別人的 uid 發討論訊息 | **accepted** | 真 PostgreSQL 真角色探針（修前紅、修後綠）。**對抗層在 0029 落地後重讀，判 refuted —— 理由正是「0029 已經關掉這個洞」，等於獨立確認修復有效** |
| 管理者可改寫訊息作者 | **accepted** | 同上 |
| 回覆指不回來源、引用是失去來源的複製品 | **accepted** | `grep -rn replyToId src/` 全 repo 只有寫入端 |
| 點了「回覆」之後沒有任何取消方式 | **accepted** | 對抗層 CONFIRMED |
| 討論查詢的 error 被吞掉，整條討論串連同快取被清空 | **accepted** | 對抗層 CONFIRMED；`loadCollaborationSummary` 五個結果全是 `res.data ?? []` |
| 回覆純網址會丟掉回覆對象 | **accepted** | 直接讀 composer 的 early-return |
| 長網址撐爆訊息卡造成橫向捲動 | **accepted** | 對抗層 CONFIRMED |
| 回覆尚未落地的訊息會撞複合外鍵 | **accepted** | 對抗層 CONFIRMED |

---

## 二、accepted — 已確認為真，但**排在後續階段**（本 PR 未修）

| 發現 | 裁決 | 排程 |
|---|---|---|
| 討論串沒有任何自動捲動（打開停在最舊、送出不捲到自己） | accepted | PR-COMM-01 |
| outbox 只活在記憶體，重整／被回收就永久消失 | accepted | PR-COMM-01 |
| 送出後立刻切房，in-flight／failed 被直接刪掉 | accepted | PR-COMM-01（需連同既有測試一起改） |
| 未綁定雲端的房：每則永遠停在「送出中」，沒有重試也沒有說明 | accepted | PR-COMM-01 |
| `created_at` 由伺服器 `now()` 決定，重試會讓兩則訊息永久顛倒 | accepted | PR-COMM-03（順序與未讀一起處理） |
| 首次分享把本機討論搬上雲時丟掉原始時間 | accepted | PR-COMM-05 |
| 語音：靜音在 token 換發後被靜默取消（UI 說靜音、麥克風其實開著） | accepted | **PR-COMM-06** |
| 語音：缺「重新連線」狀態，重連期間仍顯示綠點與舊名單 | accepted | PR-COMM-06 |
| 語音：非正常離場不寫 `left_at`，房裡永遠掛著「語音進行中」 | accepted | PR-COMM-06 |
| 語音：health 一次失敗就整個 session 沒有語音，沒有重試路徑 | accepted | PR-COMM-06 |
| 語音：麥克風被拒讀 `err.message` 而非 `err.name`，Firefox 判錯 | accepted | PR-COMM-06 |
| 語音 dock 按鈕 32px，低於專案自訂的 44px 觸控目標 | accepted | PR-COMM-06 |
| 房間搜尋只比對 branch 名稱卻回「找不到相關內容」 | accepted | PR-COMM-07 |

---

## 三、deferred-with-owner — 已確認為真，但**不屬本線範圍**（§二）

已寫進 `docs/handoffs/TEAM_COMMUNICATION_HANDOFF.md`。

| 發現 | 建議擁有者 |
|---|---|
| `comments` INSERT 沒有把 `author_user_id` 綁在 `auth.uid()` —— 回饋可被冒名 | 回饋線（與本線 0029 同一類，同一個解法形狀） |
| `comments` UPDATE 沒有作者綁定也沒有欄位凍結 —— 任何成員可改寫他人回饋並奪取作者 | 回饋線 |
| `messages`（0001 legacy 聊天）仍是 `for all` 成員即可 —— 可整包改寫或清空 | 安全線 |
| `room_members` 沒有 DELETE policy 也沒有 RPC —— 外流邀請連結等於永久授權 | 安全線 |
| `guard_room_update` 沒有涵蓋 `rooms.room_mode`，reviewer 可以 PATCH | 安全線 |
| 影片表態／快速反應先報成功再寫入（樂觀 toast 早於寫入） | 影片回饋線 |
| 重播的 comment/stroke/message/reply insert 每次重鑄新 uuid —— 回應遺失就重複列 | 回饋線 |
| `flushPending` 用自己的結果覆寫佇列，丟掉 flush 期間排進來的寫入 | 離線佇列線 |
| 並行 `reload()` 沒有順序守衛，較舊的快照可能最後落地 | 雲端同步線 |
| 白板節點／邊的 id 會 fallback 成非 uuid，毒化持久化離線佇列 | 白板線（#78） |
| Realtime proposal 更新略過 `resolvePayload`，協作者看到破圖 | 視覺提案線 |
| 綁定完成前的寫入被靜默丟棄，並被第一份快照從 IndexedDB 抹掉 | 雲端同步線 |
| Realtime 重連後不重抓，斷線期間插入的列永遠看不到而狀態說已連線 | 雲端同步線 |
| DELETE 監聽沒有房間 filter，別房的刪除會觸發本地整房重載 | 雲端同步線 |
| 三條白板手勢 e2e 檢查寫死 `check(..., true)` | 白板線（#78 正在重寫該檔） |
| `asset-analysis` edge function 參照未定義的 `dedupe_key`（`tsc` 會報 TS2552） | 素材智慧線（對抗層判該路徑不可達，但識別字確實未定義 —— 屬於待清理的真問題） |

---

## 四、rejected-with-reason — 對抗層推翻，本線不採納

| 發現 | 推翻理由（摘要） |
|---|---|
| 「服務未設定」與「連線失敗」都顯示成同一句 | 程式碼屬實，但那是 `voice-token` health 端點**明文寫死的契約**：health 刻意只回一個布林、不把 LiveKit 事實交給前端。這是設計取捨，不是疏漏。**但任務書 §十六 明確要求兩者可分辨 —— 本線把它改列為「要改契約」而不是「有 bug」，排 PR-COMM-06** |
| 等待麥克風授權時永久卡死、只能重整 | 有專門處理這個情形的路徑，宣稱的使用者可見失敗不成立 |
| 參與者列 upsert 錯誤被吞掉導致別人看不到語音進行中 | 該失敗狀態不可達：所有可能的寫入失敗都被同一個 PostgREST 往返的下一個檢查攔下 |
| `strokes` 是 `for all` 成員即可 —— 任何人可刪別人的標註 | 程式碼屬實，但那是產品刻意出貨的設計（共同標註），不是 RLS 疏漏 |
| 0001/0002/0005/0012 的表沒有撤銷預設 `GRANT ALL`（含 TRUNCATE） | 觀察屬實，但推翻理由指出 shim 與實際專案的預設權限狀態不同 —— **本線判定為「證據不足以定案，需要對真專案 probe」**，已寫進 handoff 由安全線用真專案確認（見 §五） |
| 同一房開兩條 Realtime channel 並永久洩漏 | Realtime client 以 topic 去重，宣稱的後果不成立 |
| 本分支出貨 0029 卻在自己的預約文件寫「本階段不新增 migration」 | **裁決 partially-accepted**：對抗層判 refuted（沒有使用者可見失敗），但**文件與程式碼確實不一致，那是我自己的錯**。已改寫 `MIGRATION_RESERVATION.md`，寫清楚為什麼改變決定、以及套用順序的風險 |

---

## 五、尚未取得裁決（不得當成任何結論）

74 條候選中約 31 條的 verifier 在第 2 輪仍因網路錯誤中止。這些在
`BASELINE_AUDIT.md` 一律標 **[待複驗]**，包含：

- 手機／平板 UI 的多數條目（MT-03～MT-17）——
  這一類本來就**必須用真裝置**確認，讀 CSS 不能定案。
- `upsert_visual_proposal` 的跨房寫入（SEC-01）。
- 測試盲區的多數條目（TC-02～TC-15）。

**這些沒有被確認，也沒有被推翻。** 交接時請自行複驗。
