# forge-retrospective-logging

**Single-screen retrospective logging for missed sessions in the last 3 days.**

Rapid-recall data entry optimised for the "I forgot to log Friday" moment. Pre-populates from the programme rotation for the selected date, auto-fills cells across sets, single RPE per exercise, no readiness modal, no rest timers. The engine treats the resulting record identically to a live session — same prescription decisions, same Phase 3 deload signals, same Phase 4 volume aggregates.

## Files changed

```
lib/programme.js            # 440 → 555 lines  (3 new pure helpers + JS_DAY_TO_WEEK_INDEX constant)
components/ForgeApp.jsx     # 2945 → 3615 lines  (state, handlers, RetroPickerSheet, RetrospectiveSessionSheet, home link, toast)
```

Build: 42.2 kB → **46 kB** main route (+3.8 kB for the entire flow — picker + full-screen sheet + handler + helpers).

## What the user sees

### Home screen

A subtle sage link appears beneath the recovery nudge area, **only when the engine detects a missed strength day in the last 3 calendar days**:

> Missed a session? *Log it* →

If the user trained every recent strength day, the link stays hidden — home stays calm. The visibility is fully data-driven via `hasMissedStrength(history, 3)`.

If a live draft is already open, the link is hidden (can't retro-log mid-session). If the picker were tapped during a draft, the picker would show "Finish your live session first" instead.

### Picker bottom sheet

Tapping the link opens a sage-trimmed bottom sheet listing the last 3 days. Each row shows:

- Date label (e.g. "Fri 24 Apr")
- Expected session per programme rotation (e.g. "Strength C")
- Status: ✓ logged (sage tick, dimmed, non-tappable) | tappable arrow (coral) | non-strength label (rest/cardio/zone2/hiit, dimmed)

**Only missed strength days are tappable.** Already-logged dates blocked with a sage tick. Non-strength days show as context but can't be tapped.

Footer microcopy: *"Only the last 3 days. Anything older is archaeology."*

### Retrospective session sheet

Tapping a missed day opens a full-screen form with the entire prescribed session laid out top-to-bottom. Header shows session name + date + a sage italic "Logging from memory" subtitle.

For each exercise:

- Exercise name (Fraunces) + sets × reps + muscle group
- "Skip" toggle (top-right) — toggling dims the exercise to 45% opacity and excludes it from the session record
- **Compact horizontal grid of cells** — one cell per set, defaulting to the prescribed weight (or reps for bodyweight movements). Tap any cell to open a single-cell ScrollDrum overlay
- **Auto-fill on first cell**: changing cell 1 propagates to cells 2..N IF those cells haven't been individually edited. Touching a non-first cell only changes that cell. This means a user who hit prescription cleanly only taps cell 1 once
- 3-point RPE selector below (Easy / Normal / Cooked, defaults to Normal)
- Loaded BW exercises show "+ kg" units; assisted "− kg"; pure BW only collects reps

The ScrollDrum overlay shows "Set N of M · auto-fills the rest" on cell 1 so the auto-fill behaviour is discoverable.

Bottom: a sticky **sage** "Log session →" CTA. Sage because retro logging is honest gap-filling (wellness/measurement territory), not coral training-action. Disabled state: "Skip everything?" — if all exercises skipped.

### After submission

A small sage toast slides down from the top: *"Logged Strength C for Fri 24 Apr"* — auto-dismisses after 3 seconds, tappable to dismiss early. Full DoneScreen would be jarring for rapid-fire retro entry — the toast pattern matches the "I'm catching up on three sessions" mental model.

## How it works under the hood

### The data pipeline

The handler `handleSubmitRetro` builds a session record that looks identical to a live one save for the `retrospective: true` flag and the date overrides:

1. `newDraftLog()` builds the standard v2 draft with `mesocyclePhase: "accumulation"` (or `"deload"` if a deload is active)
2. Override `id`, `date`, `dow`, `startedAt` to anchor to the SELECTED date at noon UTC. Noon-anchor avoids DST edge cases when the draft is built/finalised in different timezones
3. Set `retrospective: true` and `loggedAt: now` so we can later differentiate retro from live records
4. For each non-skipped exercise, walk the cells and call `logSet()` with weight/reps/RPE — same as a live session
5. `finaliseDraft()` produces the session record (the `retrospective` flag survives via the `...rest` spread)
6. `H.append()` adds to history — the array is sorted by `id`, so retro records land in correct chronological position relative to live records

### Engine compatibility — verified end-to-end

The same `Phase 2 + 3 + 4` engine block that runs on live session finalise runs on retro submission:

- **Phase 2 progression**: reads top-set RPE from the session record, produces ADD/HOLD/DROP — works identically on retro records
- **Phase 3 deload signals**: cooked accumulation, stall convergence, regression detection all use date-based windows — retro records land in the correct date bucket
- **Phase 3 auto-completion**: edge case where a retro session crosses the deload threshold (>4 days from deload start) — handled correctly
- **Phase 4 volume aggregates**: simple sum of `set.volume` per muscle in date windows — agnostic to retro vs live

E2E tests verify all of the above.

### The two intentional engine compromises

Per the design discussion (deliberately accepted, not bugs):

1. **No readiness collected for retro sessions.** Default is `"normal"`. This means retro sessions can't trigger the Phase 2 cooked override (the "if cooked, never ADD" rule), and don't contribute to Phase 3's "3 cooked in 14 days" signal. RPE is still collected, which is the higher-value engine input. Trade-off accepted: asking "how did Friday feel?" three days later is worse data than not asking.

2. **Muscle anchor updates apply as if the retro session were today's PR.** A 110kg squat retro-logged from Friday becomes the user's "current" Quadriceps anchor the moment they save. Strength doesn't decay in 3 days, so this is fine — but worth knowing if any future debugging looks at anchor timestamps.

### State architecture

Three new pieces of state in ForgeApp:

```js
const [retroPickerOpen, setRetroPickerOpen] = useState(false);
const [retroDate,       setRetroDate]       = useState(null); // ISO YYYY-MM-DD or null
const [retroToast,      setRetroToast]      = useState(null); // { date, sessionName } or null
```

One new screen path: `screen === "retro"` renders `RetrospectiveSessionSheet`. Otherwise unchanged.

One memoised derived value:

```js
const hasRetroGaps = useMemo(() => hasMissedStrength(history, 3), [history]);
```

Recomputes automatically as history grows. Drives whether the home link is visible.

## What's locked vs what's queued

**Locked (in this patch):**

- 3-day rolling window — anything older is intentionally not surfaceable
- Block already-logged dates (sage ✓, non-tappable)
- Block future dates (not in the picker at all)
- Block during live draft (link hidden, picker shows "finish your live session first")
- Streak healing (automatic — H.append + sort means retro records contribute to rhythm naturally)
- Single RPE per exercise applied to all sets
- Auto-fill on first cell with per-cell override tracking
- Skip toggle per exercise
- Sage CTA for "Log session" (semantic: this is gap-filling, not training)

**Not built:**

- Readiness collection for retro (deliberately skipped — 3-day-old recall is fake precision)
- BW prompt during retro (deliberately skipped — already in fudge-from-memory mode, friction not worth it)
- Done screen for retro (deliberately replaced with toast — celebration patterns don't fit rapid-fire entry)
- Editing already-logged sessions (deliberately blocked — overwrite is a foot-gun)

## Verification

- ✅ Babel parse clean across both files
- ✅ `next build` clean — 0 warnings, 0 errors
- ✅ All 13 helper unit tests pass (`sessionMetaForDate`, `findRecentDays`, `hasMissedStrength`)
- ✅ All 13 E2E tests pass (draft build, finaliseDraft preservation, engine compatibility, history sort, post-submit detection)
- ✅ Phase 3 + Phase 4 functions called in the retro engine block — same code path as live finalise

## Test checklist (post-deploy)

- [ ] Open app on Mon morning with Friday unlogged → home shows "Missed a session? Log it →" link
- [ ] Tap the link → picker shows Fri (tappable, coral arrow), Sat (HIIT, dimmed), Sun (Rest, dimmed)
- [ ] Tap Fri → full-screen retro sheet opens with all Strength C exercises pre-filled
- [ ] Tap any cell → ScrollDrum slides up, scrubbing updates that cell
- [ ] Cell 1 update auto-propagates to cells 2/3 (until you tap them individually)
- [ ] Tap "Skip" on any exercise → it dims to 45% opacity and gets excluded from the record
- [ ] Tap "Log session →" → toast slides down "Logged Strength C for Fri 24 Apr", picker no longer shows Fri as missed
- [ ] DevTools → Local Storage → `forge:<profile>:history` has a record with `date: "2026-04-24"`, `retrospective: true`, `loggedAt` ≈ now
- [ ] After retro, log a live session → the engine's prescription respects the retro session as recent history
- [ ] Try to retro a date that's already logged → not in the picker as tappable (shows ✓)
- [ ] Open picker during a live draft → all rows greyed, footnote "Finish your live session first"

## What's still queued for polish (post this patch)

- Copy polish — small wording adjustments, voice consistency pass
- Passkey nudge — discoverability for users who haven't set up cross-device auth

Neither blocks May launch.
