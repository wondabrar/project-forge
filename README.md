# forge-recovery-pack

**Recovers the rebalance-pack changes that v0's PR #49 stale-base merge clobbered. Plus CI workflow + branch-protection setup so this can't recur.**

8 files. Drop in, push, configure branch protection in GitHub UI, you're done.

---

## Why this exists

PR #49 was opened from a base commit that pre-dated your rebalance-pack upload. When v0 merged it, the merge wiped:
- **`rpeToRir` bug fix** — back to broken (only handles easy/hard/limit; "normal" and "cooked" return null → engine HOLDs silently → progression broken across the entire user base)
- **Hydrating gate / Restoring view** — back to flash-empty UI on activate
- **Day B finisher swap** — Tricep Pushdown gone, Copenhagen Plank back
- **Day C css3 swap** — Skullcrusher gone, Tricep Dips back
- **Heatmap visual alignment** — `paddingTop:2` offset back
- **9-bucket muscle palette** — back to Legs/Biceps/Triceps keys
- **Desktop ambient backdrop** — gone

Plus v0 introduced a **new bug**: SESSIONS Day A finisher exB was set to Standing Calf Raise, but `EXERCISE_POOLS["afin-B"]` wasn't updated to match. So at week 8 when rotation fires, users get auto-rotated FROM Standing Calf Raise TO Dead Bug (the old core pool default). Net: calf training disappears at the first rotation. Fixed.

What survived: cron job, vercel.json, deterministic blob paths in route.js, v0's anatomy expansion (which is genuinely good work — 166 exercises, conservative weights, some entries citing literature). **Anatomy file is NOT touched by this pack** — v0's version stays.

---

## What's in the pack

| File | Status | Change |
|------|--------|--------|
| `lib/storage.js` | Modified | **`rpeToRir` bug fix** — handle UI's `easy/normal/cooked` + legacy aliases |
| `lib/programme.js` | Modified | Day B + Day C SESSIONS swaps; afin-B + bfin-A + css3-B pool updates |
| `lib/tokens.js` | Modified | 9-bucket muscle palette |
| `components/ForgeApp.jsx` | Modified | Hydrating gate + Restoring view + cancellation flag |
| `components/PerformanceLab.jsx` | Modified | Heatmap alignment fix (`paddingTop:2` removed) |
| `app/globals.css` | Modified | Desktop ambient backdrop (≥768px) |
| `.github/workflows/ci.yml` | **NEW** | Lint + test + build on every push and PR |
| `.github/BRANCH_PROTECTION.md` | **NEW** | One-time GitHub UI setup to kill the stale-base clobber pattern |

---

## Deployment steps

### 1. Extract and verify locally

```bash
unzip forge-recovery-pack.zip -d /path/to/project-forge
cd /path/to/project-forge

# Sanity check the pack didn't break anything
git diff --stat       # should show only the 8 expected files modified
npm run build         # should succeed, ~47-48kB main route
npm run test          # should pass (40 progression engine tests)
npm run lint          # zero hook-ordering violations
```

### 2. Push

```bash
git add .
git commit -m "Recover rebalance pack changes clobbered by PR #49; add CI + branch protection

- rpeToRir: handle UI 3-point scale (easy/normal/cooked) — was returning null
  for normal/cooked, silently blocking progression for all users
- ForgeApp: blocking blob hydration with Restoring view on activate
- Programme: Day B/C accessory swaps restored; afin-B pool fixed to match
  Standing Calf Raise SESSIONS default (v0 left this mismatched)
- PerformanceLab: heatmap label/square 2px alignment offset removed
- tokens: 9-bucket muscle palette restored
- globals: desktop ambient backdrop (≥768px) restored
- CI workflow + branch protection doc to prevent future stale-base clobbers"

git push origin main
```

### 3. Configure branch protection — the critical step

Without this, the next v0 PR or any other stale-base PR will clobber things again. Estimated time: 60 seconds.

Open `.github/BRANCH_PROTECTION.md` (included in this pack) and follow it. The single most important setting is:

> ☑ **Require branches to be up to date before merging**

This is what forces a rebase/merge resolution at PR time instead of silently overwriting recent commits.

### 4. Watch the CI run

The first push triggers the CI workflow. Should complete in 2-3 minutes:
- Lint: zero violations expected
- Test: 40 progression engine tests pass
- Build: ~47-48kB main route, zero errors

If anything fails, the push doesn't gate anything (branch protection isn't on yet) — just fix and re-push.

After branch protection is enabled in step 3, future pushes/PRs will require CI green before merge.

---

## Verification done in this pack

- ✅ All 6 modified files parse clean (Babel)
- ✅ 14 recovery integration tests pass (rpeToRir all UI values + round-trips + pool[0]/SESSIONS alignment for all 6 finisher/superset slots)
- ✅ The `afin-B` pool/SESSIONS misalignment v0 introduced is fixed

## Not done — your job

- `npm run build` locally (the test harness here can't run the full Next.js build)
- `git diff origin/main...HEAD` pre-push audit (the habit that catches everything)
- Branch protection setup (60 seconds in GitHub UI)
- Watching the first CI run go green

---

## Net change footprint vs current main

```
MODIFIED
  lib/storage.js          rpeToRir + rirToRpe (+40 lines, mostly comments)
  lib/programme.js        SESSIONS + 3 pools rebuilt (+5 lines net)
  lib/tokens.js           MUSCLE_COLOURS palette (+11 lines)
  components/ForgeApp.jsx hydrating state + gate view (+40 lines)
  components/PerformanceLab.jsx -1 line (paddingTop:2 removed)
  app/globals.css         desktop @media blocks (+24 lines)

NEW
  .github/workflows/ci.yml          42 lines
  .github/BRANCH_PROTECTION.md      36 lines
```

Bundle size delta: negligible (~+200 bytes, mostly the new hydrating screen JSX).

---

## After this lands

The rotation/focus questions from the previous turn are still open. Happy to come back to them properly with the strategic engagement they deserve — programme behaviour at 10-12 weeks, "all kit available" propagation through rotation, the "shared pain + personal variation" focus picker design. Just say the word.

Eviction of v0 noted. For future greenfield contributions (like the anatomy expansion, which was genuinely valuable work), you can come to me directly in a session, or use Cursor/Claude Code on the actual codebase. The PR-based integration was the problem, not the underlying intelligence.
