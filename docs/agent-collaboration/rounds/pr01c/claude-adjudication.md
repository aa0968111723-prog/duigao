# Claude 裁決 — PR-01c（手機上傳強化）Grok round

日期：2026-08-28 ｜ 分支：feat/mobile-upload-hardening ｜ PR #56
Grok findings：`grok-findings.json`（verdict MUST_FIX；F1/F2 blocking、F3 medium）

## 總表

| # | Grok 判定 | 裁決 | 處置 |
|---|---|---|---|
| F1 | high：.mov 警告提早 return，繞過 100MB 上限與空檔拒絕 | **接受** | 已修＋3 unit |
| F2 | high：目標路徑上 branch「補完」是空操作；合成 branch id 可直通 uuid 欄 | **接受（分兩半裁決）** | 已修 |
| F3 | medium：check 24 斷言釘不住（恆真、Map 順序、swallow） | **接受** | 已收緊為 7 斷言 |

## F1

早期 return 位置錯誤 — 警告分支移到大小/空檔檢查**之後**，收檔契約對
所有格式一視同仁。unit：.mov 帶警告、超大/0-byte .mov 被拒、mkv 仍拒。

## F2 — 兩半

**（a）合成 id 直通 uuid 欄**：真洞，且**先前即存在**（addVideoVersion
對 input.branchId 無 isUuid 檢查）。已堵：非 uuid 的 branchId 不進列 —
branchless 是正確答案，0013 assign_version_branch trigger 在 INSERT 時
補真分支。

**（b）「冪等補完 branches」在目標路徑是空操作**：主張與事實不符，
接受。裁決為**誠實化而非硬補**：fresh 單房在雲端 branchless 是正確
狀態（trigger 補真分支；client normalizeRoomBranches 自己長回顯示用
預設分支）。為合成 id 鑄「確定性 uuid」硬補反而製造第四種分支來源。
completeRoomSetup 的責任邊界改寫進註解：uuid 分支（project 房）真補；
合成分支明確不補、並說明為何這是對的。media_type/room_mode PATCH 的
補完仍是實質內容 — check 24 現在直接斷言 `media_type=video` 落地。

## F3

check 24 收緊為 7 斷言：copy wait 不吞（逾時即紅）；房 id 用前後差集
（不靠 Map 順序）；「重試進播放器」由恆真改為 playerReady 實測；補完
以 `cloudRooms.get(armedRoomId).media_type === "video"` 直接觀測；版本
落點釘在死亡當下那間房的 id 上。165/165。

## 回歸

video 165/165、multi-branch unit 12/12（含新 media unit 3）、collab
34/34、multi-branch e2e 21/21、share 72/72、review-viewer 27/27、
migrations 232/232（#55 已入 main）。

## 結論

F1/F2 blocking 已修（F2b 以誠實化裁決並記錄理由）；F3 落實。可 merge。
