# RELEASE_RISKS

1. **AI Apply is local-optimistic.** Cloud upsert/discussion insert can still fail after the UI says 已套用. Discussion write remains fire-and-forget (`insertDiscussion` not awaited). Tracked as residual of TA-001, not fully closed for network failure.
2. **create_plan_draft extra-confirm** still creates a real plan branch. Reviewer is gated; owner/editor is not.
3. **No production evidence.** BLOCKED_ZEABUR_ACCESS.
4. **Open board realtime** (TA-004) can lose peer edits — do not market live whiteboard.
5. **feature-map still over-reports** other items (`intelligent-asset-library` in-memory). This PR only tightened `whiteboard-apply-back`.
