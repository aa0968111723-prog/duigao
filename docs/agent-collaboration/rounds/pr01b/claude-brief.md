# Round: pr01b — Universal Intake（實際 diff review）

審 pr01b.diff（本 branch 對 origin/main 的 src+scripts+migrations diff）。焦點：

1. **Migration 0018 安全性**：attachments 前綴 policy 有沒有 OR 放寬 versions/videos/proposals？add-only 是否真的成立（上傳者不能 update/delete）？payload CHECK 繞得過嗎？library shared-insert 補丁是否完整（trigger 順序、NULL 分支）？replay 舞步（0016/0017 復活舊 policy）e2e 是否鎖死？
2. **附件流正確性**：上傳→insert 順序、重試不重傳的保證、上傳成功+insert 永久放棄的殘留物件（已聲明 bounded garbage）、綁定前的行為、outbox ghost 相容（附件卡從 ghost payload 完整渲染？）。
3. **渲染安全**：link href 白名單繞得過嗎（大小寫、空白、相對 URL）？attachment 卡把 payload.mime/size 當顯示還是當安全判斷？signed URL 有沒有洩進 payload/DB？
4. **九站收斂**：DataTransfer 物化有沒有破壞任何凍結站（CreateSheet 持有、share cover 三 MIME、video 單檔、proposal 白名單）？刪 UploadZone 有沒有殘引用？
5. **E2E 誠實度**：新檢查會不會假綠？migrations 探測是否真的證明了聲稱的界線？

輸出逐項 finding：{severity, claim, evidence, repro, suggested_fix, blocks_release}＋總裁決 APPROVE/MUST_FIX。
