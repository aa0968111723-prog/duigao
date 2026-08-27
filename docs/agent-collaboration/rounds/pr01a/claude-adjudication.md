# Adjudication: pr01a（Grok MUST_FIX → 已全數修復）

Grok round 1（grok-findings-round1.json，23 turns，diff+原始碼對照）裁決 MUST_FIX，
10 findings。逐項裁決與處置：

| # | Sev | Finding | 裁決 | 處置 |
|---|---|---|---|---|
| F1 | high/blocks | 殼沒掛 useViewport，--kb 是死變數（E2E 手動 set 造成假綠） | **屬實，已修** | MultiBranchRoom 頂層掛 useViewport()；unit source-contract 加驗（collaboration-workspace.test） |
| F2 | high/blocks | push-pane z-28 < composer z-30，composer 穿出面板 | **屬實，已修** | pane→32、overlay→40、composer 30 |
| F3 | high/blocks | outbox 跨房洩漏；sending 會 stamp 進下一間房 | **屬實，已修** | hook 增 localRoomId；房間切換丟棄不屬於目前房的 entry；ghosts/sendStates 都按房過濾；flush 只補送屬於目前房的 |
| F4 | high/blocks | insert 成功即丟 ghost，早於 serverIds；併發快照讓訊息消失 | **屬實，已修** | 成功轉 acked 繼續當 ghost，只有 id 出現在伺服器快照才丟棄；E2E 新增「ghost 活過整包快照替換」實測（26/26） |
| F5 | high/blocks | legacy messages 可支持/回覆 → 打 room_discussion_* FK 失敗 | **屬實，已修** | payload.legacy 標記＋RoomDiscussion 對 legacy 隱藏互動；App.supportDiscussion 增 id 存在守門 |
| F6 | medium | one-shot 在 cache-first 快照缺 branch 時被吃掉 | **屬實，已修** | 只有目標真的存在才消耗；roomLink 每次頁面載入重建，無需跨房 reset |
| F7 | high/blocks | E2E 假綠（手寫 --kb、retry 無快照插入）；漏 one-shot/影片 drawer/merge unit | **屬實，已修** | ghost-過-快照、one-shot nudge、桌機影片 drawer segment、mergeRoomBranch collab-keys 與 lazy-plans unit 全補；--kb 行為測試保留＋source-contract 補強 |
| F8 | medium | plans 空 blocks 守門把 lazy 與真清空混為一談 | **屬實，已修** | planFromRow 標 blocksOmitted（summary select 缺欄）；App 守門只擋 lazy 列；完整空列按 updatedAt 比新 |
| F9 | medium | overlay/drawer Escape 未接 | **屬實，已修（overlay+pane）** | bubble-phase document listener＋defaultPrevented 讓內層 ladder 先吃；App image ladder 消費時補 preventDefault。drawer 的 Escape 由宿主 sheet 持有（DragSheet 行為未變），記為殘餘 |
| F10 | low | drawer 漏語音說明 | **屬實，已修** | showVoiceNote prop，drawer 傳 false |

## 修復後證據

multi-branch-e2e 21/21（含 one-shot）｜collaboration-e2e 26/26（含 ghost 過快照）｜
review-viewer 26/26｜video 158/158（含桌機 drawer segment）｜share-e2e 72/72｜
share-preview 176/176｜migrations 201/201｜unit：agent 15、asset-intelligence 9（+ai-proposals 5）、
collaboration 39、multi-branch 9 全綠｜agent:gate PASS。

殘餘（非阻擋）：drawer 內 Escape 交由宿主 sheet；acked-ghost 路徑由與 failed-ghost
共用的對帳機制覆蓋（E2E 直接驗 failed 路徑）。

## Round 2（grok-findings-round2 = grok r2 驗收）

裁決 MUST_FIX：8 FIXED、F3/F9 PARTIAL（皆為修復引入）。處置：

| # | Finding | 處置 |
|---|---|---|
| N1 (high, F3 殘餘) | 隔離 effect 在 bind re-key 時刪掉 in-flight sending（roomId 還是本機 id）；insert 失敗會無聲消失 | **已修**：對帳抽成純函式 reconcileOutbox（遷移→補送→隔離，處理 bound/re-key 分兩次 render 到達的兩種順序；prevBound 守門擋 A→B 誤遷）。新增 scripts/tests/discussion-outbox.test.ts 6 例，含 Grok 指定的兩個情境（re-key 中 ghost 存活、A→B 不補送） |
| N2 (medium, F9 殘餘) | document bubble 先於 window bubble，defaultPrevented 協議死路；一次 Escape 關兩層 | **已修**：overlay/pane 的判定推遲到同步派發完成後（setTimeout 0 讀 defaultPrevented，順序無關）；Video ladder 與 BottomSheet 消費時補 preventDefault |

Round-2 複驗：outbox unit 6/6；collaboration-e2e 26/26、review-viewer 26/26、
video 158/158、multi-branch 21/21（隔離跑；同機並行多 suite 時有負載 flake，
CI 2-core 兩度綠）。殘餘：drawer 內 Escape 由宿主 sheet 持有（DragSheet 無
keydown，行為與 main 相同）。
