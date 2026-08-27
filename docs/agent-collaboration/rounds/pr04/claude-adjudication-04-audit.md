# Claude 裁決 — PR-04 剩餘（AI 套用稽核）Grok round

日期：2026-08-28 ｜ 分支：feat/ai-apply-audit ｜ PR #54
Grok findings：`grok-findings-04-audit.json`（verdict **PASS**，全 low）

## 總表

| # | Grok 判定 | 裁決 | 處置 |
|---|---|---|---|
| H1–H4 | 四個攻擊面守住（anon/null actor、0014 replay、誠實敘事、CHECK 相容） | 同意 | 無 |
| F1 | 探針可偽陰：(f) 空表偽陰；缺 actor NULL / asAnon 探針 | **接受** | 已補 4 探針，232/232 |
| F2 | `recordAiApplyAudit?.(...).then` 方法缺失時 TypeError 落 catch | **反駁（事實錯誤）** | 無變更 |

## F2 反駁

Optional chaining 的短路涵蓋**整條後續成員鏈**（ECMA-262 §13.3.9）：
`obj.method?.(args).then(cb)` 在 method 為 undefined 時整條表達式直接
求值為 undefined，`.then` 不會被求值。實測：
`node -e "const o={}; console.log(o.f?.({}).then((x)=>x))"` → `undefined`，
無 TypeError。Grok 描述的「TypeError 落入 catch、套用被誤報失敗」不會
發生。維持原碼。

## F1 落實

- actor_user_id NULL：`with check` 三值邏輯只收 true — 已釘
- asAnon insert / select：0014 revoke all from anon — 已釘
- (f) 強化：owner 同窗讀 ≥1（列存在）＋ stranger 讀 0（RLS 濾掉，
  排除「空表/全拒絕」偽陰）

migrations e2e 232/232。

## 結論

PASS 裁定成立；F1 補強落地、F2 以規格與實測反駁。可 merge。
