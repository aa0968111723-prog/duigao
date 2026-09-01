# embedded-editor checkpoint
branch: feat/embedded-editor-phased
nextPhase: DONE
done: [P0, P1, P2, P3, P4, P5]
blocked: []
notes: |
  P5 evidence + skeptic fixes:
  - normalizeItem keeps crop; normalizeDoc JSON round-trip
  - updateProposalItem → undoProposalEdits restores crop (same path as hook)
  - crop CSS: .proposal-image overflow hidden + has-crop aspect-ratio lock so clip windows
  - 390 完成: setEditing(false) + composeExitRef; shouldSyncComposeSession(exiting) 不重開
  - poster-compose 25 pass; mobile-tablet-ux 9; tsc 0
