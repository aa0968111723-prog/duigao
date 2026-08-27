# Adjudication: pr00（Grok 裁決 PLAN_MUST_REVISE → 已修訂）

Grok session 01a043f5-d163-7c40-84d3-221e51a9435b、grok-4.6-build、19 turns、read-only worktree。
原始輸出：grok-findings.json（Grok 自寫）＋ grok-session-output.json（headless stdout）。

| # | Sev | Finding 摘要 | 裁決 | 處置 |
|---|---|---|---|---|
| F1 | critical | 「討論是 Home」被做成改預設 tab；tab 殼還在，仍是互相競爭的分頁 | **接受** | ROADMAP PR-01 重寫：討論＝房間殼；內容/企劃/白板由討論卡推進（可返回），非並列 tab；voice 在 BLOCKED 期間不占 pane |
| F2 | critical | 開有版本的 poster/video 會離開房間殼（App.tsx:2264-2270），整條 ROADMAP 沒 owner | **接受** | 「從討論打開內容必可返回、不丟房間脈絡」納入 PR-01 範圍（對稿面 = overlay/push，不是第二個 app） |
| F3 | high | Home 與「討論卡＝進內容」被切開在 01/02，01 會先交出聊天 tab | **接受** | IA＋返回討論＋卡→內容合併進 PR-01；UniversalIntake 拆成 PR-01b |
| F4 | high | PR-01 混四件事；宣稱吃掉沒做的 Thread gap；缺訊息遷移 ADR | **接受** | 拆 01a/01b；Thread 明確標「PR-01 不做，見 ADR-009」；新增 ADR-008 雙訊息表策略 |
| F5 | high | 討論附件走 registerIntelligentAsset 撞 reviewer 權限（0015:530-531 要 can_manage_media）；「資產庫」無 client | **接受** | PR-01b 改走討論訊息 kind（附 migration：新增 kind + 成員可寫的附件 storage 路徑，與 versions 分離）；gate 改「訊息卡出現 PDF」；reviewer 可補充檔案不可管理版本 |
| F6 | high | 鍵盤/--kb 沒接到討論 composer；bottom-nav 同底相撞；被誤丟 PR-08 | **接受** | PR-01 gate 必含手機 viewport：composer 在鍵盤上、不被 bottom-nav 蓋住 |
| F7 | high | 圖片上傳 fire-and-forget、影片無續傳、HEVC 無主；沒有真正的 upload PR | **接受** | 新增 PR-01c（上傳強化）：圖片 await＋錯誤＋重試；影片斷點提示；HEVC 選檔時說明 |
| F8 | high | PR-04 要寫 audit 但 event_type CHECK 只有 3 種且 policy 只有 SELECT；chunk 有效上限 5000 非 8000；「不改契約」寫太寬 | **接受** | PR-04 範圍加 migration（擴 event_type＋insert 途徑）；edge chunk cap 對齊 agent；改述為「HMAC/action union 不動，長度 cap 可修」 |
| F9 | medium | ADR-005 把 S2S artifact 一併 BLOCKED 過寬 | **接受** | ADR-005 收窄：禁 iframe/proxy/editor REST；允許 AIOS-key S2S contract＋fixture＋MP4 artifact 現在做；EDL 等 auth |
| F10 | medium | audit 的 PR 編號與 ROADMAP 對不上；stale-write IDB 推舊版、broadcast stub、library_assets 跨房 RLS、upsert:true 無 owner | **接受** | ROADMAP 加「audit-gap → PR 對照表」；stale-write 歸 PR-02；library RLS＋upsert 歸 PR-01b（可立即做）；Task 見 ADR-009 |
| F11 | medium | single-mode「補討論面」未定義，恐把 reviewer 極簡對稿膨脹成 tab 殼 | **接受** | 寫進 PR-01：單房＝對稿 workspace＋討論 drawer；invariants（reviewer-progressive-disclosure）不破 |
| F12 | medium | 本 branch 把 #42 寫成已合併基準；實際 base 是 f327a70 | **接受** | PROJECT_STATE/TEST_STATUS 改述：基準 f327a70；#42 為 sibling OPEN |
| F13 | medium | feature-map 假 IMPLEMENTED（apply-back/library 的證據是未 mount 檔案）；ADR-007 拒改造成 01 開工時 context 撒謊 | **接受（部分）** | PROJECT_STATE 加「scanner 誤報清單」；scanner 改良（mounted-import 證據）排入 PR-02 同批；不在計畫 PR 改 feature-map 數值本身 |
| F14 | medium | 討論寫入 fire-and-forget（App.tsx:1103-1104），佇列只收 node；要當 Home 不能這樣 | **接受** | PR-01a 範圍加：composer 失敗可見＋重試；durable queue 擴 discussion 排 PR-02 或 01a 視規模 |

## 修訂結果

ROADMAP.md / DECISIONS.md / PROJECT_STATE.md / PR_INDEX.md 已按上表重寫（見同 commit diff）。
audit 兩處錯誤已修正（F-抽查）：§五 transcode 文件存在（docs/pr29）；plan chunk 有效上限 5000。
