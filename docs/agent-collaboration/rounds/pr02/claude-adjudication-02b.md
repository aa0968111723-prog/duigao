# Adjudication: pr02b（Grok MUST_FIX → 已修復）

Grok（15 turns）裁決 MUST_FIX：F2 blocking＋四項非阻擋。逐項：

| # | Sev | Finding | 裁決 | 處置 |
|---|---|---|---|---|
| F2 | high/blocks | refetch 對開著的板是空操作（summary nodes=[]）；toast 說謊；lastAcked 空轉 → 409 迴圈只是從佇列搬到 live | **屬實，已修＋更深一層** | (a) 衝突改 loadWhiteboard(該板)（非整房 reload）；writeAck 不再空 reload；toast 等圖換完才說、且說實話。(b) 深層：reconcileNodes 原以 updatedAt 比新 — 衝突中的本地列 updatedAt 較新、version 較舊，refetch 後仍勝出、acked 卡死。改為 **version 不同時 version 說了算**（OCC 計數器為伺服器真相；同 version 才用 updatedAt）。e2e 以真 409 驗全迴圈：衝突→誠實 toast→板 refetch→伺服器列被採納→下一筆編輯落地（32/32） |
| F3 | medium | flush 清鍵盲刪可能誤殺後到的新 payload | **屬實，已修** | clearPendingEditIf(id, createdAt)：只清「列出當下那一份」 |
| F1 | low | isStaleWrite 只看 message；漏接會退回 F10 | **接受** | CloudError 傳遞鏈 fixture 測試已加；details/hint 形變留觀察 |
| F4 | low | delete conflict 分支 SQL 不可達（trigger 只掛 UPDATE） | **屬實，已刪死碼** | 註解指向 ADR-011 的離線 delete 語意缺口 |
| F5 | info | ADR-011 缺等版本 LWW 與離線 delete 無 OCC | **已補記** | DECISIONS.md ADR-011 補記 |

複驗：collaboration-e2e 32/32（含新衝突迴圈 ×2 檢查）、multi-branch 21/21、
review-viewer 27/27、video 158/158、unit 43、agent:gate PASS。
