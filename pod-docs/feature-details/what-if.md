# What-if

## What it is
**Try changes** on the Assessment page lets you flip objective statuses and see the resulting score and changed-requirement count without saving anything.

## How it works
- `apps/web/src/score/useWhatIf.ts` holds pending changes in memory, merges them over the saved rows (`input.ts`) and calls the same `evaluateAssessment` as the API. Nothing is sent to the server.
- The banner reads "What-if, not saved", the what-if score, the change (for example +1) and how many requirements changed.
- **Reset changes** clears the pending set and stays in what-if; **Exit** drops it and leaves.
- Example: 3.1.20 Not Met (72), set all its objectives Met: "What-if score 73, Change +1, 1 requirement changed". After Exit the score is 72 and `/api/audit` has no new entry.

## Why it's this way
- The UI and the API share one rules function so the two scores can't disagree (plan Key decisions).
- It runs in the browser, so it answers at once and writes no audit noise.

## Watch out
- Exit must clear pending changes. The review caught tests that stayed green when `setPending(NONE)` was removed from `exit`; PR #14 made them fail properly. Re-entering must show "0 requirements changed".
- The what-if view carries the open POA&M list, so it applies the "Not Met needs an open POA&M" blocker too.

## History
- 2026-11-25 · plan cmmc-l2-grc · built (assessment sprint, PR #6); exit tests hardened in PR #14 · [report](../reports/cmmc-l2-grc.html)
