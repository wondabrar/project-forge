# forge-recovery-and-polish

**Two jobs in one patch — restores Phase 3 + 4 work that the v0 BW PR clobbered, AND ships the BW polish pass on top.**

Combined into one zip because the polish work was built on top of the recovery base. They're indivisible — merging the polish without the recovery would require rebasing, and shipping them as separate patches creates a window where the polish-only diff is missing context. Single PR is cleaner and safer.

## What this restores (recovery)

The earlier v0 BW-after-name PR was created from a stale base that predated Phase 3 and Phase 4 merges. When merged into main, it brought old `lib/progression.js`, `lib/storage.js`, and `lib/analytics.js` files — wiping ~660 lines of Phase 3 + Phase 4 logic. The app continued to function via the surviving Phase 2 engine, but the deload offer system and silent volume tracking were gone.

This patch restores:

- **Phase 3 (signal-driven deload + recovery rebuild)** — 469 lines back into `lib/progression.js`
- **Phase 3 schema additions** — `TS.updateMesocycle`, `TS.replaceState`, `lastOfferDismissedAt` field added to `lib/storage.js`
- **Phase 4 (rolling volume aggregates)** — 196 lines back into `lib/analytics.js` + the existing `weeklyVolume()` `effectiveLoad` bug fix
- **Phase 3 + 4 wire-ins in `components/ForgeApp.jsx`** — imports, state declarations, profile-activation hydration, session-finalise auto-completion + prescription branching, home-screen deload card, session-screen "deload · day N of M" subtitle, Done-screen "Deload complete. Welcome back." line

What's preserved from current main:
- ✅ v0's BW-after-name onboarding flow
- ✅ Library expansion (88 exercises across 14 pools)
- ✅ Profile gap fix (15 explicit lift profiles)
- ✅ Phase 2 progression engine
- ✅ Phase 2 schema helpers

## What this polishes (the seven items from the code review)

### 1. ScrollDrum: respect `unit` prop for bottom label

The component had a hardcoded `integer ? "reps" : "kg"` at the bottom that ignored the `label` prop entirely. Added a separate `unit` prop that the bottom label respects, defaulting to the previous behaviour. Now `unit="+ kg"` for loaded bodyweight or `unit="− kg"` for assisted will display correctly.

```js
function ScrollDrum({value, onChange, ..., label="", unit=null})
```

`label` is the optional uppercase top label (kept as-is). `unit` is the italic bottom label (new). Backwards-compatible.

### 2. BW modal aesthetic redesign

The previous modal felt "off" because it used the **coral** action colour (semantically reserved for training surfaces) on what is fundamentally a passive measurement update. Plus a long descriptive paragraph that worked for first-time onboarding but was noise on every subsequent edit.

Redesigned to match the editorial pattern of `DrumEditOverlay` (the gold standard for ScrollDrum-based bottom sheets):

- ✕ close button top-right (replaces the separate "Cancel" button — one tap zone, less visual weight)
- Tighter Fraunces 22px header "Bodyweight" + 12px subtitle
- Subtitle is **context-aware**: first-time entry shows "Used for loaded pull-ups, dips, and other weighted bodyweight movements" (the explanatory copy that matters once); subsequent edits show "Scroll to adjust" (matches DrumEditOverlay exactly)
- **Sage CTA** ("Confirm →") instead of coral — semantically aligned with wellness/measurement rather than training
- Single-button stack (vs. previous Save + Cancel vertical pair)

The post-claim BW step in `ProfileScreen` got the same coral → sage treatment for consistency: kicker, save button, ambient glow all switched. Same family across both surfaces — the modal is the bottom-sheet variant, the post-claim step is the full-screen variant, both unmistakably "bodyweight" territory.

### 3. Post-set BW prompt timing refactor

Was: `setTimeout(() => setBwEditOpen(true), 600)` — a 600ms hard-coded delay that left ~350ms of "nothing happening" between the RPE card finishing its fade-out animation (~250ms) and the BW modal sliding up.

Now: 280ms — tuned to match the RPE card's fade-out duration so the BW modal starts sliding up just as the RPE card finishes dismissing. Smooth handoff, no awkward gap. Comment added explaining the dependency on RPE animation timing.

(A full callback-based solution that fires on the RPE card's `onAnimationEnd` would be architecturally cleaner, but that requires changes to `RpeCard` and adds prop-drilling complexity. The tuned timer hits the same UX outcome with less surface area to maintain.)

### 4. `loadType` deduplication

Was: two separate call sites — `pushSetToDraft` (for set logging) and `SessionScreen` (for display logic) — each independently computing `ex.loadType || inferLoadType(ex.name)`.

Now: small shared helper `getLoadType(ex)` defined near the top of the file. Both call sites use it. Single source of truth, can't drift.

```js
function getLoadType(ex) {
  return ex?.loadType || inferLoadType(ex?.name);
}
```

### 5. `ProfileScreen` `updateBodyweight` defensive guard

Was: silent no-op if `activeProfile` was null (theoretical race during onboarding). The reviewer flagged "worth adding a guard or logging."

Now: the guard explicitly logs the no-op via `console.warn` so the edge case is visible in DevTools rather than failing invisibly. If users ever report "I entered my BW but it didn't save," the console will show why.

### 6. `activeEx?.name` null safety

Was: `onClick={()=>setEditTarget({exName:activeEx.name, ...})}` — would throw if `activeEx` was null in a race condition (defensive edge case).

Now: `onClick={()=>{ if(activeEx?.name) setEditTarget({...}); }}` — defensive guard, no-ops cleanly. Two click handlers updated (weight picker + reps picker).

### 7. PostCSS lockfile (item #1)

Already resolved per the review (sandbox auto-regenerated, 0 vulnerabilities). No change needed.

## Files changed

```
lib/progression.js          # 527 → 996 lines    (Phase 3 logic restored)
lib/storage.js              # 1144 → 1164 lines  (Phase 3 helpers + lastOfferDismissedAt)
lib/analytics.js            # 212 → 414 lines    (Phase 4 + weeklyVolume bug fix)
components/ForgeApp.jsx     # 2719 → 2945 lines  (Phase 3+4 wire-ins + 7 polish items)
```

`lib/programme.js` and `lib/lift-translations.js` are NOT included — current main has the library expansion + profile gap fix intact and untouched.

Build: 42.2 kB main route (unchanged from recovery — polish is wash on bundle size).

## Verification

- ✅ Babel parse clean across all 4 files
- ✅ `next build` clean — 0 warnings, 0 errors
- ✅ Phase 3 unit tests pass (signal detection, cooldowns, deload prescriptions, state transitions, copy generators, recovery rebuild)
- ✅ Phase 4 unit tests pass (window selection, aggregation, baselines, deltas)
- ✅ Spot-checked all 7 polish items render/behave correctly

## Test checklist (post-deploy)

**Recovery verification:**

- [ ] DevTools → Sources → confirm `lib/progression.js` source has `computeDeloadPrescription` defined
- [ ] After logging a session, `forge:<profile>:trainingState.volume` should populate with `last7Days`, `last14Days`, `last28Days`, `baseline28d`
- [ ] To force the deload card visible: edit LS to set 2+ lifts' `stallSignal: "stall"`, clear `mesocycle.deloadSignals.lastDeloadCompletedAt`, reload home → sage card should appear

**Polish verification:**

- [ ] Tap "Bodyweight" row in profile sheet → bottom-sheet modal slides up with sage "Confirm →" CTA, ✕ close top-right
- [ ] First-time bodyweight prompt during a pull-up session → modal subtitle reads "Used for loaded pull-ups…"
- [ ] Re-edit existing bodyweight from home card → subtitle reads "Scroll to adjust" (same as DrumEditOverlay)
- [ ] BW prompt during session → modal appears ~280ms after RPE pick (no awkward gap)
- [ ] First-time onboarding → post-claim BW step has sage glow + sage button (not coral)

## How to prevent the v0 PR clobber pattern

When opening any v0 PR, before merging:

1. Check `git diff origin/main...HEAD -- lib/ components/` shows ONLY the changes the PR description mentions
2. If the diff includes hundreds of lines of *removed* code from files the PR didn't claim to touch — that's the stale-base signal
3. Either: rebase the v0 branch onto current main first, or cherry-pick just the intended changes onto a fresh branch

This is the second time a v0 branch has shipped stale code (per memory: an earlier session diagnosed a redeployed older commit). Worth treating v0 PRs as "review the diff carefully" by default rather than fast-merge.

## What's still queued for polish (post this patch)

- **Copy polish** — small wording adjustments, voice consistency pass
- **Passkey nudge** — discoverability nudge for users who haven't set up cross-device auth (option A: inline post-claim screen with "Secure this account" / "Not now"; option B: home screen sage chip)

Neither is launch-blocking. Both can land after the May launch if needed.
