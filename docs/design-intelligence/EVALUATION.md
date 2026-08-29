# Design Intelligence — 評估報告

分支鏈：`agent/design-intelligence-perplexity` → `di02` → `di03` → `di04` → `di05` → `di06`

這份報告記錄**實際跑出來的結果**，不是計畫。每一條都對應一個可以重跑的指令。

---

## 1. 七個驗收案例（任務書第二十一節）

指令：`npm run test:design-intelligence`（`design-intelligence-eval.test.ts`）

| 案例 | 情境 | 驗到的事實 | 結果 |
|---|---|---|---|
| A | 海報，使用者只說「感覺不夠專業」 | 每條診斷都有量測值與具體色碼；三個方案碰的維度數量不同；量出來的排在模型說的前面 | 通過 |
| B | 影片分鏡 | **不編造鏡頭秒數**（沒讀過影片）；`requiresApproval: true`；patch 標成不可逆 | 通過 |
| C | 企劃書 | 白板與 planform-iso 兩條路都產得出 payload，產生 patch 後提案狀態完全沒變 | 通過 |
| D | 網站 | 只走結構化色票；完整的核准 → 套用 → 復原路徑走得通 | 通過 |
| E | 品牌規範與通用規範衝突 | 專案規範排第一；衝突寫進 `risks` 並明說「系統不會替你選」 | 通過（**修正後**，見 §4） |
| F | 完全沒有金鑰 | 功能仍然有用；所有診斷都是量出來的；信心值下修；只給一個保守方案不硬湊三個 | 通過 |
| G | 惡意網頁內容 | 指令被標記、信心壓低、內容保留給人看；轉知識條目時最高只到 `unverified`；偽造 `approved` 被 provenance 擋下 | 通過 |

另外兩條貫穿全部案例的紅線：

- **五種作品類型走完，沒有任何一個提案自己走到 `applied`**，也沒有產生 `patch`。
- **Canva 未連線時整條流程仍然走得完**，而且誠實說明缺什麼。

---

## 2. 測試總覽（全部實際跑過）

| 指令 | 結果 | 內容 |
|---|---|---|
| `npm run test:design-intelligence` | **163/163** | 契約驗證、知識檢索、本地分析器、分析流程、出入站安全、對抗審查反例、研究層、提案呈現、adapter、七個驗收案例 |
| `npm run test:migrations` | **284/284** | 0027 知識庫 RLS/CHECK/trigger、0028 使用量表 append-only |
| `npm run test:design-research-fn` | **14/14** | edge function 的 **POST 路徑**（不是只有 OPTIONS） |
| `npm run test:proposal-ui` | **59/59** | 五個裝置尺寸的真實驗收 |
| `npm run test:edge-cors` | 6/6 | 預檢契約（新函式自動納入） |
| `npm run test:agent` | 16/16 | 既有，未受影響 |
| `npm run test:asset-intelligence` | 15/15 | 既有，未受影響 |
| `npm run test:collaboration` | 79/79 | 既有，未受影響 |
| `npm run test:multi-branch` | 25/25 | 既有，未受影響 |
| `tsc --noEmit` | 乾淨 | |
| `vite build` | 綠 | |

**變異測試：跨六個階段共 50 個變異體，全數被殺死。**
變異測試的價值不在數量，在於證明「拿掉實作，測試會紅」——
而這一路上它抓到了 5 條我自己寫的假綠。

---

## 3. 安全

### 金鑰

| 位置 | 狀態 |
|---|---|
| `PERPLEXITY_API_KEY` 在前端 | **不存在**。前端呼叫 `design-research` edge function，金鑰只在那一端 |
| 金鑰出現在任何回應 | **測試擋住**：上游回 401 並在錯誤裡帶著金鑰時，回應不含它，上游錯誤原文也不原樣回傳 |
| 金鑰在網址 | **測試擋住**：走 `Authorization` header（網址會進 log 與 referrer） |
| 金鑰在測試 fixture | 第一次提交時**違反過**，被 GitHub 推送保護擋下，已改成合成假值並改寫 commit。全歷史零命中 |
| 金鑰在 commit / README / prompt | 零 |

### 出站（私人內容不外流）

用**白名單建構**而不是黑名單過濾：`buildResearchQuery` 只接受 `question`、固定詞彙表的 `targetType`、以及 `topics`。房間的討論、附件、成員、企劃內容**沒有欄位可以進來**。

掃到金鑰時**拒絕送出**而不是遮掉再送。前端與後端各掃一次（前端那道可以被繞過）。

實測抓到兩個自己的漏洞：`\b` 貼著關鍵字時 `SUPABASE_SERVICE_ROLE_KEY` 前後都不成立邊界；被擋下的結果原本把含金鑰的原始問題帶回去。

### 入站（外部內容是資料）

`quoteUntrusted` 移除控制字元、零寬字元與雙向覆寫字元，標記 prompt injection 樣式，截斷。**刻意不刪除可疑內容本身** —— 使用者有權看到那個網頁到底寫了什麼。

外部來源的信任等級最高只到 `machine`（可疑時 `unverified`），**永遠不會是 `approved`**。

### SSRF

`isSafePublicUrl` 採預設拒絕：任何 IP 字面值、DNS 尾點、單標籤主機名、已知迴環別名網域全擋。

**誠實的極限**：主機名比對擋不完 —— 任何人都能把自己的網域指向 127.0.0.1。所以 `fetchRelevantSnippets` **刻意不實作**：本專案從不 fetch 外部回傳的網址，那些網址只作為出處顯示給人看。

### RLS

| 表 | 讀 | 寫 |
|---|---|---|
| `design_knowledge`（通用） | 所有 authenticated | **沒有 client 政策**（只有 migration seed 與 service_role） |
| `design_knowledge`（專案規範） | `is_room_member` | `can_manage_media`，且 `created_by = auth.uid()` |
| `design_research_usage` | `is_room_member` | **沒有 client 政策**，append-only |

跨房負例、DELETE 負例、冒名寫入、append-only 都有 probe。

---

## 4. 這一路上被抓到的問題

外部對抗審查（`grok`）三輪，加上自己的變異測試與驗收套件，總共修了 **29 個真問題**。分類如下。

### 「讓不可信輸入自我認證」（4 個）

同一個錯誤犯了四次，每次換一個欄位：

1. 知識條目的 `trustLevel` 只在 `status === "machine-researched"` 時降級，而 `status` 也來自同一份不可信輸入 → 改成由呼叫端傳入的 `provenance` 決定上限。
2. `contentHash` 接受輸入給的值 → 一律重算。
3. 診斷的 `measured` 接受模型自己填 → 一律 false，只有本地分析器能設 true。
4. 診斷的 `dimension` 靠 id 字串前綴推導，而 id 由模型給 → 改成自帶欄位，並強制替模型的 id 加命名空間。

### 「名實不符的紅線」（3 個）

1. `canTransition` 是**死碼** —— 全 repo 只有測試呼叫它，任何人都能直接把 status 設成 `applied`。新增 `lifecycle.ts` 讓狀態改變只有一條路。
2. 分析流程裡有一行 `checkCancelled` **永遠不可能觸發**（`raceWithAbort` 已先攔下）。刪掉，改測「取消訊號有沒有真的傳給 provider」。
3. adapter 的 `terminal` 判斷永遠不會改變結果（狀態機已涵蓋）。刪掉。

三個都是同一個原則：**一條沒有人使用、或永遠不會觸發的檢查是裝飾，不是防線。**

### 「CHECK 遇到 NULL 或空白就放行」（2 個）

1. `array_length('{}', 1)` 回傳 **NULL**，CHECK 遇到 NULL 一律放行 → 零規則的知識條目寫得進去。
2. 改用 `btrim` 之後，PostgreSQL 的 `btrim` **預設只去半形空格** → `array[E'\t']` 照樣過關。

兩個都是 migration probe 實測到的，不是讀程式碼發現的。

### 「量錯東西」（4 個）

1. WCAG 的「大字」定義：拿 `isHeading` 當粗體的代理是錯的，看的是**字重**。
2. 對比只對 `background` 算，而字可能落在 `surface` 上 → 取最差底色。
3. `analyzers.ts` 與 `schema.ts` 對同一件事有兩套算法且不一致。
4. `occupiedRatio` 對抽屜一律回上限，不反映實際的展開狀態。

### 「假綠」（5 個，其中 3 個是我自己寫的）

1. 診斷的壞樣本一次缺兩個必填欄位，等於沒測到另外兩欄。
2. 0027 的 probe 沒有跨房負例也沒有 DELETE 測試；`anon 讀不到` 用 `!== "7"`。
3. `contentHash` 的「碰撞」測試用的不是真的碰撞對。
4. e2e 的「展開後仍留 20% 給作品」在抽屜**根本沒展開**時也通過（量到動畫中間值）。
5. e2e 的滑動測試失敗其實是元素在視窗外，差點被誤讀成產品 bug。

### 「權限的預設值」（1 個，而且是全庫性質）

把 migration probe 從「用超級使用者驗」改成「用真的 `service_role` 驗」之後，
順帶查了 grant 的實際內容，發現 **`authenticated` 一直握有 `TRUNCATE`**。

Supabase 的 default privileges 對 `public` schema 的新表是
`grant all to anon, authenticated`，而**RLS 不管 `TRUNCATE`** ——
所有的 policy 對它一條都攔不住。全庫 40 張表都有這個狀況。

本分支的兩張表已修（`revoke all` 之後逐項給，並補了 probe）。
其餘 40 張分屬其他工作線，寫進 handoff H-7。

**實際可利用性低**：PostgREST 不提供 `TRUNCATE`，全庫也沒有使用者可呼叫的
動態 SQL RPC。這是縱深防禦的缺口，不是敞開的門 —— 這一點必須說準確。

### 「功能缺口」（2 個）

1. 衝突偵測只在同類別內比對 → 品牌規範（`brand-rules`）與無障礙知識（`typography`）的直接矛盾被漏掉。這是**驗收案例 E 實測到的**，也是最容易真實發生的一種衝突。
2. 沒標 `applicableContexts` 的條目被放進一個叫 `*` 的桶，與有標脈絡的條目永遠不會比對。

---

## 5. 行動裝置與平板

`npm run test:proposal-ui` 在五個指定尺寸上跑，**59 條斷言全過**。

| 尺寸 | 版面 | 收起時佔畫面 | 展開時佔畫面 | 橫向捲動 | 作品可點（收起／展開） |
|---|---|---|---|---|---|
| 360×800 | 底部抽屜 | 7.0% | ≤ 80% | 0px | 是／是 |
| 390×844 | 底部抽屜 | 6.6% | ≤ 80% | 0px | 是／是 |
| 412×915 | 底部抽屜 | 6.1% | ≤ 80% | 0px | 是／是 |
| 768×1024 | 側邊分割 | 40.0% | 40.0% | 0px | 是／是 |
| 820×1180 | 側邊分割 | 39.0% | 39.0% | 0px | 是／是 |

**展開狀態也驗過**：原本這一組檢查只在抽屜收合時跑（收合只佔 7%，怎麼樣都會過），
把 `maxHeightRatio` 改成 1.0 讓展開蓋滿整個畫面，測試照樣全綠 ——
對抗審查指出的假綠，已補。

「作品中心點可點」用的是 `document.elementFromPoint`，不是 DOM 存在性 —— WB03 踩過一次，兩個元素都在 DOM 裡、測試全綠，但覆蓋層的 z-index 比內容低，**使用者看到的是空白**。

面板自己的每個按鈕都 ≥ 24×24：這個功能的分析器就在檢查這條規則。

---

## 6. 無障礙

這個功能本身就在檢查無障礙，所以自己不能違反：

- 面板的每個按鈕 ≥ 44×44（實測，高於 WCAG 的 24×24 下限）。
- 極矮視窗（軟鍵盤彈出）時，把手退回 32px 的可點下限而不是遵守 12% 的佔比上限
  —— 一個按不到的把手比一個稍微佔位的把手更糟。這是刻意的取捨，寫在程式碼裡。
- **套用按鈕不只靠 `disabled`**：點擊處理器自己再查一次閘門。`disabled` 是畫面
  提示，不是安全機制 —— e2e 會把它拿掉再按，確認仍然不會套用。
- 內文行高 1.5、`prefers-reduced-motion` 有處理。
- `aria-label` / `aria-expanded` / `role="status"` / `role="alert"`。
- CSS 全部走變數，不寫死色碼 —— 亮/暗主題由變數決定。

**未驗證**：實際的螢幕閱讀器朗讀順序、鍵盤 focus trap。這兩項需要真機與輔具，列進人工驗收。

---

## 7. 效能

沒有做正式的效能量測 —— 誠實說明原因：這一層目前**沒有接到任何真實資料**，量出來的數字不代表實際情況。

已經做的成本控制：

- 快取（同一個問題不重複付費，命中不算進用量）
- 去重（同時問同一件事只送一次）
- 斷路器（連續失敗直接停，冷卻後半開再試）
- 前後端各一份配額
- 逾時上限 45 秒
- 本地分析器完全不需要網路

---

## 8. 誠實的限制清單

| 項目 | 狀態 |
|---|---|
| 真實的 Perplexity 呼叫 | **從未發生**。沒有金鑰，測試全部用 stub |
| `pplx` CLI / Perplexity MCP | **未安裝**，任務書的 CLI/MCP 流程無法在此環境驗證 |
| `irm` | **未安裝**，對抗審查用的是 `grok` |
| edge function 部署 | **從未部署** |
| 真實 AI provider | **未接**，唯一的 provider 是 `mock`（`id` 就叫 mock、`model` 回 null） |
| 語意檢索 | **沒有**。repo 沒有 pgvector，用 lexical + 中日韓 bigram，同義改寫抓不到（有一條測試把這個天花板釘住） |
| 接進 `App.tsx` | **沒有**。面板目前只在獨立的驗收 harness 裡跑 |
| 真機測試 | **沒有**。Playwright 的裝置模擬不等於真的 iPhone/iPad |
| Canva / CUTOS / planform-iso 的自動套用 | **沒有實作**，只有契約與 payload |

---

## 9. 需要人工處理

1. **輪替 `PERPLEXITY_API_KEY`** —— 它曾被貼進代理對話視窗，應視為已外洩。放後端 secret（**不得**用 `VITE_` 前綴），並設預算上限。
2. 補 `TKU_ZEN_AGENT_URL` 到 Supabase secrets（既有阻塞，非本分支引入）。
3. 部署 `design-research` edge function。
4. 真機驗收：iPhone / Android / iPad 各一台，確認軟鍵盤、`100dvh`、螢幕閱讀器朗讀順序、鍵盤 focus trap。
5. 決定合併順序（見 handoff H-6）與 `App.tsx` 的接線由誰負責。
6. `supabase/functions/asset-analysis/index.ts:511` 的 ReferenceError（稽核時發現，不屬本分支 —— handoff H-1）。
