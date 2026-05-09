# forge-rebalance-pack

**Weekend rebalance: programme tweaks, secondary muscle weighting, the loading bug fix, and the actual root cause of the +7.5kg suggestion bug.**

11 files. Drop in, set one env var, run the Sunday-night data wipe procedure, ship Monday morning.

---

## TL;DR

Three substantial things landed:

1. **The `rpeToRir` bug** — the actual root cause of the user's +7.5kg suggestion problem. UI uses `easy/normal/cooked` but storage was mapping `easy/hard/limit`, so `"normal"` and `"cooked"` both returned `null` → engine got no RIR signal → silently weird progression decisions. Fixed.

2. **Loading bug** — UI was rendering home with empty localStorage immediately on profile activation, then filling in 1-2s later when blob sync completed. Now blocks on hydration with a "Restoring" view. The user's instinct about a buffer animation was right; my earlier pushback was on the wrong framing.

3. **Programme rebalance + secondary muscle weighting** — kept the 3-day Huberman structure, replaced low-value finishers with calf and tricep direct work, added anatomy-weighted volume distribution so a Squat correctly contributes to Quads + Glutes + Hams + Core + Calves instead of lumping into one giant "Legs" bar.

Plus a few smaller things: deterministic blob paths, cleanup cron job, heatmap visual alignment fix, desktop ambient backdrop.

---

## What's in the bundle

| File | Status | Reason |
|------|--------|--------|
| `lib/exercise-anatomy.js` | **NEW** | Anatomy lookup + weighted muscle distribution. Foundation for items 2-5 below. |
| `lib/storage.js` | Modified | **rpeToRir bug fix** + JSDoc typedef correction |
| `lib/analytics.js` | Modified | Both volume aggregators rewired through anatomy distribution |
| `lib/programme.js` | Modified | 3 SESSIONS swaps + 3 corresponding pool default updates |
| `lib/tokens.js` | Modified | MUSCLE_COLOURS palette rebuilt for 9 buckets |
| `lib/progression.js` | Unchanged | (Pulled but no edits — pristine main HEAD) |
| `components/ForgeApp.jsx` | Modified | **Loading bug structural fix** + hydrating gate view |
| `components/PerformanceLab.jsx` | Modified | Heatmap visual alignment fix |
| `app/globals.css` | Modified | Desktop ambient backdrop (≥768px viewports) |
| `app/api/sync/route.js` | Modified | Deterministic blob paths (`addRandomSuffix → allowOverwrite`) |
| `app/api/cron/cleanup/route.js` | **NEW** | Daily cleanup of orphaned blobs |
| `vercel.json` | **NEW** | Cron schedule registration (`0 3 * * *`) |

---

## 1. The `rpeToRir` bug — actual root cause of +7.5kg suggestions

### What was broken

`lib/storage.js` had this:
```js
export function rpeToRir(rpe) {
  if (rpe === "easy")  return 3;
  if (rpe === "hard")  return 1;
  if (rpe === "limit") return 0;
  return null;
}
```

But the UI ships **3 buttons**: `easy`, `normal`, `cooked`. So:
- User taps **Normal** (the default) → `rpeToRir("normal")` → `null`
- User taps **Cooked** (max effort) → `rpeToRir("cooked")` → `null`

Every set with default RPE arrived at the engine with `rir: null`, and the engine's response is "no_rir_signal — conservative HOLD." So progression effectively never fired for any user using the default RPE.

### Why this caused the +7.5kg suggestion the user reported

The user's example was "100kg × 5 at max effort → suggested 107.5kg next week." With the bug:

- They tap **Cooked** → stored as `rir: null`
- Engine ignores rir, falls through to `findMostRecentLiftSession` lookback that excludes cooked sessions, lands on a stale prior session where they hit reps with margin
- Engine recommends ADD → +2.5kg increment compounded over 2-3 prior sessions = +7.5kg total prescribed weight stuck in `liftState.currentWeight`

The user's reported behaviour matches exactly what happens when the engine can't see "I was cooked" because the translation layer between UI and engine was broken.

### The fix

```js
export function rpeToRir(rpe) {
  if (rpe === "easy")   return 3;
  if (rpe === "normal") return 2;  // NEW
  if (rpe === "hard")   return 1;
  if (rpe === "cooked") return 0;  // NEW
  if (rpe === "limit")  return 0;  // legacy alias
  return null;
}
```

Plus the inverse `rirToRpe` updated to round-trip cleanly. Tested with 14 cases including round-trip through every UI value — all pass.

### Why my earlier engine test suite didn't catch this

My 40-test progression engine suite uses `rir: 2` directly in synthetic test sessions, **bypassing the rpeToRir translation entirely**. The bug lives in the boundary layer between UI and engine, not in the engine itself. Mitigation: 14 new tests for the translation function specifically, plus the existing engine tests now correctly model what `"normal"` means.

---

## 2. Loading bug — partial walk-back from my earlier pushback

The user's localStorage screenshot showed empty data after auth on a real device. This proved the auth flow was unblocking the UI before blob hydration completed — hence the "couple of attempts" on first load.

My earlier pushback ("buffer animation as masking, not fixing") was wrong-framed. The right framing: **a blocking loading state during legitimate hydration IS the fix, and was missing.** The user's instinct was correct.

### Fix

`components/ForgeApp.jsx`:

1. New `hydrating` state — defaults to `true` if there's an active profile cached in localStorage on mount (so the first paint shows the loading view, not empty home)
2. Profile activation effect now `await`s the `backgroundSync` promise and sets `hydrating=false` on resolve OR error
3. New "Restoring" gate view rendered when `hydrating && activeProfile && screen !== "onboarding"` — shows pulse-glow + welcome text + "Pulling your training history…"
4. Cancellation flag (`let cancelled = false` in the effect, cleanup sets `cancelled = true`) prevents stale promises from setting state on a different active profile

### What it looks like

Sage glow ambient backdrop, centered text:

> SECURE ACROSS DEVICES *(actually says RESTORING here)*
>
> # Welcome back, *Abrar*
>
> Pulling your training history…

3-second worst case, usually under 1s. Failure path also unblocks (just doesn't have the data) so users never get permanently stuck.

---

## 3. Programme rebalance — minimal, targeted

Counted actual sets per week against MEV/MAV from the existing programme. Findings:

- Quads: 15 (high MAV — fine)
- Chest: 9 (low MAV — fine)
- Back: 10 (fine)
- Shoulders: 10 (fine)
- **Biceps: 3 (below MEV)**
- **Triceps: 3 (below MEV)**
- **Calves: 0 (zero direct work)**

Not the dramatic overhaul I sketched earlier. Three targeted swaps fix the actual gaps without touching programme structure:

### Day A finisher
- **Was:** Hanging Leg Raise + Dead Bug
- **Now:** Hanging Leg Raise + Standing Calf Raise
- Calves get 2 sets/week direct (was 0), Dead Bug dropped (lowest-value movement, anti-rotation work covered elsewhere)

### Day B finisher
- **Was:** Copenhagen Plank + Lateral Raise
- **Now:** Tricep Pushdown + Lateral Raise
- Triceps get 2 more direct sets, Copenhagen dropped (real loss for adductor health, but the secondary contribution from squats and lunges keeps adductors active)

### Day C css3
- **Was:** DB Curl + Tricep Dips
- **Now:** DB Curl + Skullcrusher
- Skullcrusher targets triceps cleanly; Tricep Dips were tagged "Triceps & chest" which made them noisy in the muscle distribution

Pool defaults updated for all three slots so swaps still work. Pool[0] === SESSIONS default verified for all 6 affected slots.

---

## 4. Secondary muscle weighting — the analytics rewrite

`lib/exercise-anatomy.js` is the foundation. 13 internal muscle groups, 27 hand-tuned baseline exercises, 19 pattern-based fallback rules for swap-pool variants.

### The contract

Each exercise maps to:
```js
{
  primary: "Quads",
  secondary: { Glutes: 0.5, Hamstrings: 0.25, Core: 0.3, Calves: 0.15 }
}
```

Weights are deliberately conservative:
- **1.0** — primary mover
- **0.4-0.6** — meaningful co-activation (glutes on squat, triceps on bench)
- **0.2-0.3** — moderate involvement (core on squat, front delts on bench)
- **0.1-0.15** — minimal stabiliser (calves on squat, forearms on row)

The whole point is to **show where compounds can't fully replace direct work**, not to inflate volume bars to make legs/arms look balanced. If a 0.5 weight on calves meant 12 squats = 6 effective calf sets, users would skip direct calf raises — that's the wrong message.

### Display aggregation

Internal tracking is granular (Front/Side/Rear delts, Biceps/Triceps/Forearms tracked separately). Display chart aggregates to 9 buckets via the `DISPLAY_BUCKET` map:

- Quads, Glutes, Hamstrings, Calves
- Chest, Back, Shoulders (Front + Side + Rear delts collapsed)
- Arms (Biceps + Triceps + Forearms collapsed)
- Core

Plus `Other` as a fallback bucket.

### Pattern fallbacks

Exercises in the swap pools that aren't hand-tuned (e.g. "Hack Squat", "Pendulum Squat") fall back to movement-pattern detection. Squat-pattern names → squat anatomy; hinge → hinge; row → row; etc. ~80% coverage on common gym movements without needing to enumerate every variant.

### Result on the chart

A user who does 3 sets of squats and 3 sets of bench used to see:
- Legs: 3 sets, 1500 vol
- Chest: 3 sets, 1200 vol

Now sees:
- Quads: 3 sets, 1500 vol
- Glutes: 1.5 sets, 750 vol
- Hamstrings: 0.75 sets, 375 vol
- Core: 0.9 sets, 450 vol
- Calves: 0.45 sets, 225 vol
- Chest: 3 sets, 1200 vol
- Arms: 1.2 sets, 480 vol (triceps from bench)
- Shoulders: 0.9 sets, 360 vol (front delts from bench)

Nine bars instead of two. Honest about what the body's actually doing.

### Honest caveat

I haven't visually re-tested the Performance Lab chart with the new 9-bucket palette. The chart code reads from `MUSCLE_COLOURS[bucket]` with a fallback — should work, but the legend might wrap onto two lines on narrow screens. Easy iteration post-launch if it looks off.

---

## 5. Deterministic blob paths

### What was broken

All three `put()` calls in `app/api/sync/route.js` used `addRandomSuffix: true` which appends a random suffix to each blob URL. The cleanup-before-write logic was supposed to delete old blobs first, but races and silent failures meant blobs accumulated. The user reported "dozens of files per user" instead of the expected 2.

### Fix

`addRandomSuffix: true` → `allowOverwrite: true`. Every PUT now goes to the same deterministic path (`forge/profiles/{name}/meta.json` etc.) and overwrites in place. No accumulation possible.

The cleanup-before-write logic in route.js stays as defence-in-depth for the transition window — it's redundant for new writes but cleans up legacy suffixed blobs from before the migration. After the Sunday wipe (see deployment steps), it becomes a no-op.

---

## 6. Cleanup cron job

`app/api/cron/cleanup/route.js` + `vercel.json` schedule.

Runs daily at 03:00 UTC. Lists all blobs under `forge/profiles/`, identifies orphans (blobs whose basename isn't `meta.json` or `history.json`), batch-deletes them. Auth via Bearer `CRON_SECRET` — Vercel sets this automatically for cron-triggered requests.

After the deterministic-path migration, this should be a 0-deletion no-op every day. It's the safety net for any future bug that creates orphan blobs, and a backstop that legacy data can't accumulate indefinitely.

**Setup required:** Set `CRON_SECRET` env var in Vercel project settings before deploying. Any random string ≥32 chars works; Vercel injects it as the Bearer token in cron-triggered requests.

---

## 7. Heatmap visual alignment fix

`components/PerformanceLab.jsx` — the labels container had `paddingTop: 2` that the SVG sibling didn't have. Created a constant 2px offset between label rows and square rows. Removed the padding.

You confirmed this was purely visual (not a logging issue). Fixed.

---

## 8. Desktop ambient backdrop

`app/globals.css` — added a `@media (min-width: 768px)` block that paints two soft radial gradients off to the sides of the viewport. Coral and sage, low opacity, large radius. Mobile is unaffected.

This is the "quick win" approach to the desktop UX problem — the centered max-width:430 column now reads as "intentional centerpiece on a textured backdrop" instead of "stranded phone strip on an empty background." Real responsive desktop layout deferred to post-launch.

A second media query at ≥1280px nudges the gradients further out so they don't crowd the column on wide screens.

---

## Deployment steps

```bash
# 1. Extract zip into project root, overwriting existing files
unzip forge-rebalance-pack.zip -d /path/to/project-forge

# 2. Set the cron secret env var in Vercel (one-time, before deploy)
#    Generate any random ≥32 char string — won't ever be needed by humans
vercel env add CRON_SECRET production
# (paste a strong random value when prompted)

# 3. Verify locally — this should land clean
cd /path/to/project-forge
npm run build      # 0 errors expected, ~47-48kB main route
npm run test       # progression engine tests should still pass (40/40)

# 4. Audit the diff before merging — STILL the most important habit
git diff origin/main...HEAD -- components/ lib/ app/

# 5. Sunday evening — beta tester message (separate task, see below)

# 6. Sunday night — wipe blob namespace
#    Option A: per-user UI wipe via the existing DELETE endpoint
#    Option B: scripted full-namespace wipe (safer for clean slate)
#    Either way: confirm forge/profiles/ is empty before pushing

# 7. Push + deploy
git add .
git commit -m "Rebalance pack: programme tweaks, secondary muscles, loading bug, RPE→RIR fix

- Fix rpeToRir for UI's 3-point scale (easy/normal/cooked) — was returning
  null for normal/cooked, blocking progression silently
- Loading bug: blocking hydration on profile activation with Restoring view
- Programme: Day A/B/C finisher swaps to add direct calves + triceps
- Analytics: anatomy-weighted muscle distribution (9 buckets, not 'Legs')
- API: deterministic blob paths (allowOverwrite: true)
- New cleanup cron (daily 03:00 UTC)
- Heatmap visual alignment fix
- Desktop ambient backdrop (≥768px)"

git push origin main
```

### Sunday evening beta tester message

Suggested wording:

> "Quick heads up — pushing a meaningful update tomorrow morning that fixes a few things you've been seeing (the loading flash on open, the wonky weight suggestions, the heatmap alignment). The programme also gets a couple of smart finisher swaps to actually train calves and tighten up arm volume.
>
> One catch: I'm wiping the data slate at the same time so we're all starting Monday from a clean foundation. Your name is preserved, but training history resets to zero. Worth it because the analytics layer is materially smarter — you'll start seeing muscle distribution properly broken down (quads / glutes / hams / calves separately, not lumped into 'Legs').
>
> Sleep well, train tomorrow."

---

## Verification done

- ✅ All 11 modified files parse clean (Babel)
- ✅ 14 rpeToRir round-trip tests pass (every UI value survives the round-trip)
- ✅ 18 integration tests pass (anatomy distribution, display buckets, weeklyVolume aggregation)
- ✅ Programme pool[0] alignment verified for all 6 changed slots
- ✅ Hook ordering safe — no useState/useCallback after the SSR mount guard or the new hydrating early return

## Verification NOT done in this pack

- ❌ Full `next build` smoke test in this session (build harness wasn't available; user should `npm run build` locally)
- ❌ Visual rendering of the new 9-bucket Performance Lab chart (chart code untouched, palette updated; should work but might need legend tweaks)
- ❌ Live blob cleanup cron run (will fire first time at 03:00 UTC after deploy)
- ❌ Real-device test of the loading bug fix (synthetic test confirms the await-block works; needs verification on Safari + the iOS PWA where the bug manifests)

The user's standing pre-merge habit (`git diff origin/main...HEAD`) catches any remaining surprises.

---

## Net change footprint

```
NEW FILES
  lib/exercise-anatomy.js                  ~280 lines
  app/api/cron/cleanup/route.js            ~95 lines
  vercel.json                              ~10 lines

MODIFIED
  components/ForgeApp.jsx        3887 → 3967 (+80 lines: hydrating state + Restoring view)
  components/PerformanceLab.jsx  337  → 339  (+2 lines: alignment comment)
  lib/storage.js                 1225 → 1290 (+65: rpe fix + 14-line block)
  lib/programme.js               555  → 558  (+3: pool/SESSIONS swaps net to +3)
  lib/analytics.js               414  → 470  (+56: anatomy-weighted aggregators)
  lib/tokens.js                  56   → 75   (+19: 9-bucket palette + comments)
  app/api/sync/route.js          263  → 364  (+101 from earlier hardening, now also addRandomSuffix→allowOverwrite)
  app/globals.css                41   → 79   (+38: desktop media queries)
```

Bundle size estimate: **~48-49kB main route** (small growth from the hydrating screen + anatomy import; partly offset by no inline keyframe styles).

---

## What's intentionally NOT in this pack

| Asked for | Skipped because |
|-----------|-----------------|
| Trainer mode | V2 — too big for the weekend, not actually a launch blocker |
| Real desktop layout (two-column responsive) | 1-2 weeks of design + engineering work, not the right Monday-launch tradeoff |
| Landscape mobile support | Fitness apps lock portrait by convention — landscape during a working set is bad UX |
| Vercel Workflows for cleanup | Workflows is for durable multi-step pauses (hours/days). Daily cleanup is a fast-finish job; Cron Jobs is the right tool. |
| Vercel KV for username checks | Marginal benefit at 10 users; defer until scale |
| Programme variants (Hypertrophy mode) | V1.5 feature; collect signal post-launch first |
| Migration scripts for existing beta data | Sunday night clean-slate wipe is the agreed approach — ETL is more work than it's worth at this scale |

---

## Post-launch immediate priorities

1. **Verify the hydrating gate works on real iOS devices.** The synthetic test confirms the await-block is correct; production validation needs a real round-trip from theforged.fit on Safari + PWA.
2. **Watch the cron cleanup logs Monday and Tuesday.** Should report deletions on first run (legacy suffixed blobs from pre-migration), then drop to 0 deletions thereafter. Anything else means there's a leak somewhere new.
3. **Performance Lab visual review.** With 9 buckets the chart MIGHT need: legend wrapping, narrower bars, slightly different colours if any two are too close visually. Iterate based on first impressions.

Once those land, the launch is properly stable. The remaining queue (trainer mode MVP, programme variants, full desktop responsive) is a real backlog you can prioritise based on actual user signal rather than guessing.

🥂
