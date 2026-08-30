# Conflict resolution — 2026-08-30

Goal: GitHub 開著 PR 不再顯示 merge conflict（dirty）。

Repo 正確做法不是 rebase 舊 dirty 分支，而是：
1. 已重放進 main 的 dirty PR 關掉
2. 還沒進 main 的獨特改動，從現行 main 開新分支重放

## 已清淨（對現行 main `ee835f1` 無衝突）

| PR | mergeable_state | 說明 |
|---|---|---|
| #163 | clean | 0032 mentions/todos，取代 dirty #162 |
| #164 | clean | 墮碿刪除必須等雲端 ack |
| #165 | clean | 未 SUBSCRIBED 不畫「已同步」 |
| #166 | clean | realtime DELETE 帶 room_id filter |
| #167 | clean | 未讀水位寫入失敗不假成功 |
| #168 | blocked（非 dirty） | GAP-07 ack 重放 |

## 已關閉

| PR | 原因 |
|---|---|
| #78 | 被 #113 取代 |
| #162 | dirty；唯一剩餘由 clean #163 承接 |

## Dirty 但已被 main 重放，應關閉

| Dirty PR | Main 重放 |
|---|---|
| #95 | #107 TUS / transcode / library |
| #96 | #105 Home 離線／雲端未設定 |
| #98 | #106 語音九態 |
| #116 | #113 whiteboard 0024–0028 |
| #150 | #160 acceptHydratedDraft |
| #151 | #120 sessionEntryStatus |
| #152 | #120 voiceDockLeave.ts 已在 main |
| #154 | #120 flushOutboxOnOnline |
| #157 | #159 hashchange 重讀 roomLink |

## Dirty 且仍有獨特改動（重放中 / 待重放）

GAP-07 ack 系列 #126 #128–#149：集中到 #168。
#129 已接上 `setHumanAssetMetadata`。#131 #132 #134 #135 helper 檔已進本分支。

GAP-08 #155 #156：空正文／空標題不是投票／決策，尚未重放。
#158 mobile/tablet UX：在 #110 之後還有額外 UX，需獨立重放。

不 rebase、不 force-push 舊 dirty 分支。不 merge、不 deploy。
