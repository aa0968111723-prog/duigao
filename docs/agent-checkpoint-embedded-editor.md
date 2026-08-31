# embedded-editor checkpoint
branch: feat/embedded-editor-phased
nextPhase: DONE
done: [P0, P1, P2, P3, P4, P5]
blocked: []
notes: |
  P5 evidence:
  - npx tsx --test scripts/tests/poster-compose.test.ts 25 pass
  - npx tsx --test scripts/tests/mobile-tablet-ux.test.ts 9 pass
  - npx tsc --noEmit 0
  - npm run test:collaboration 323 pass
  - npm run agent:gate PASS: AUTOMERGE REQUIRES AGENT_GATE_PASS
  - no new supabase/migrations; FIRST_LAYER_TABS still ["對話","白板"]
  - SHOTS=UNCAPTURED (no headed 胸章 fixture here)

  Ship: 390 Mobile Dock; 768/1024 Desktop same Dock; compose 卸 pin；五鍵＋文字＋素材比較存成新版本完成；crop JSON；圖上快捷；對照滑桿圖下緣。
