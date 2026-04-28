# forge-passkey-nudge

**Three-surface passkey discoverability — onboarding step + escalating home nudge.**

Closes the orphaned-account UX gap. Before this patch, the only way to discover the passkey feature after onboarding was to open the profile sheet (most users never do). After this patch, every new user gets a proactive consent moment during onboarding, and any user who skipped gets a visible reminder on home that escalates by surface (not frequency) over time.

## Files changed

```
lib/storage.js              # 1164 → 1225 lines  (PN helper + PN_SNOOZE_MS constant)
components/ForgeApp.jsx     # 3615 → 3887 lines  (state, handlers, onboarding step, chip + card, success toast)
```

Build: 46 → **47.2 kB** main route (+1.2 kB for the entire passkey nudge system).

## What the user sees

### Onboarding (first-time only, WebAuthn-supported devices only)

After name claim, before BW step, a sage-themed full-screen prompt:

> SECURE ACROSS DEVICES
>
> # Add a *passkey*?
>
> Without one, your data lives only on this device — clearing your browser would lose everything.
>
> With one, your name is yours across phone, laptop, anywhere. Face ID, Touch ID, or your device PIN.
>
> **[ Add passkey → ]**
>
> *Later*

Three exit paths all advance to the BW step — onboarding never breaks:

1. **User accepts and ceremony succeeds** — passkey registered, advance to BW
2. **User accepts but cancels/fails the OS prompt** — soft error message in-place ("Setup didn't complete. Try again or skip for now."), user controls retry vs skip; on skip via "Later" they advance
3. **User taps "Later"** — silent advance, no error

**Capability gate**: If WebAuthn isn't supported on this device, the onboarding step is bypassed entirely. Direct claim → BW. No point asking for something the device can't do.

### Home — chip phase (days 0-3 from profile creation)

If the user skipped onboarding without registering, a subtle inline link appears:

> *Secure your name across devices →*  ✕

- Tapping the link runs the WebAuthn ceremony directly from home (no detour through profile sheet)
- Tapping ✕ snoozes the nudge for 7 days
- Sage-tinted, no card chrome — reads as a discoverability cue, not an interruption
- Hidden if profile already has a passkey, or device doesn't support WebAuthn, or snoozed

### Home — card phase (days 4+ from profile creation)

After 4 days, the chip escalates to a sage card with explicit consequence framing:

> SECURE ACROSS DEVICES
>
> ## Add a passkey
>
> Without one, your data lives only on this device. Face ID, Touch ID, or your device PIN — takes a second.
>
> **[ Set up passkey → ]**

- Same in-place ceremony as the chip — tap the button, run WebAuthn, no detour
- ✕ in the corner snoozes for 7 days
- After day 4, **the card stays static**. Repeated dismissals don't escalate further. No nagging theatre.

### Success toast

After successful passkey registration (from any surface), a sage toast slides down:

> Passkey added. *Your name's secure now.*

3-second auto-dismiss, tappable to dismiss early. Same toast pattern as the retro logging completion.

## How it works under the hood

### State model

A new per-profile LS record drives the nudge:

```ts
forge:<profile>:passkeyNudge = {
  createdAt: ISO timestamp,    // set on profile claim, never overwritten
  snoozedUntil: ISO | null,    // set to now+7d on manual dismiss
}
```

The `PN.stage(profile)` function returns `"chip" | "card" | "hidden"`:

- Active snooze (snoozedUntil > now) → **hidden**
- No record → **hidden** (caller is responsible for `PN.init` on profile claim)
- Age < 4 days → **chip**
- Age ≥ 4 days → **card**

Notably, `PN` doesn't know about `hasPasskey()` — that's the caller's job. ForgeApp checks both `pnStage` AND `pnHasPasskey` before rendering. This separation means the snooze logic is testable without mocking the WebAuthn API.

### Hydration on profile activation

On every profile activation, the `useEffect` block calls:

```js
PN.init(activeProfile);                    // idempotent — only seeds if missing
setPnStage(PN.stage(activeProfile));        // initial stage from LS

isPlatformAuthenticatorAvailable().then(supported => {
  setPnWebAuthnSupported(supported);
  if (!supported) setPnStage("hidden");     // capability gate
});

hasPasskey(activeProfile).then(has => {
  setPnHasPasskey(has);
  if (has) setPnStage("hidden");            // already-secured gate
});
```

The two async checks run in parallel and both can independently force the stage to hidden. No race conditions because we only ever transition TO hidden, never away from it.

### The handler trio

Three handlers in ForgeApp:

- `handleRegisterPasskeyFromHome` — runs the WebAuthn ceremony directly. On success: hides nudge forever, fires success toast. On user cancellation: silent 7-day snooze (cancellation isn't a failure). On error: surface message, don't auto-snooze (let user retry).
- `handleSnoozeNudge` — manual dismiss. 7-day snooze.
- The onboarding step uses its own local handlers (`handlePasskeyAccept`, `handlePasskeyLater`) inside ProfileScreen — separate state because the onboarding ceremony has different error-handling semantics (in-place retry vs falling back to chip on home).

### What's intentionally NOT escalated

A few things I considered but rejected:

- **Showing the card every 3 days within a 7-day window** — frequency escalation teaches users to dismiss without reading. Same content reappearing more often becomes wallpaper. The chip→card surface escalation creates ONE genuine new prompt.
- **A second escalation tier (like a modal blocker)** — too aggressive for a feature the user can legitimately not want. After day 7, the card stays static.
- **Tracking dismiss count and escalating after N dismissals** — same reasoning. If they've dismissed it once consciously, that's data. Punishing them isn't.

### Cleanup

Folded in v0's flagged redundancy from the retro logging review (lines 3163-3164 had identical `T.bg2` / `T.bg3` for both skipped and non-skipped — ternary did nothing). Removed the conditionals, kept the literal values.

## Verification

- ✅ Babel parse clean across both files
- ✅ `next build` clean — 0 warnings, 0 errors
- ✅ All 10 PN unit tests pass (init, stage transitions, snooze cooldown, idempotency, edge cases)
- ✅ All 9 flow tests pass (fresh user, dismiss/escalate, accept-from-onboarding, accept-from-home, day-3.99 vs day-4 boundary)

## Test checklist (post-deploy)

**Onboarding:**

- [ ] New user, name claim → passkey screen with "Add passkey" / "Later"
- [ ] Tap "Add passkey", complete OS prompt → BW step opens, profile has passkey
- [ ] Tap "Add passkey", cancel OS prompt → soft error in-place, can retry or tap "Later"
- [ ] Tap "Later" → BW step opens, no passkey, home will surface chip tomorrow
- [ ] On a non-WebAuthn device (rare, e.g. some embedded webviews) → no passkey screen, direct to BW

**Home — chip phase:**

- [ ] User who skipped passkey onboarding sees chip on home: "Secure your name across devices →"
- [ ] Tap chip → OS prompt → success toast → chip vanishes forever
- [ ] Tap ✕ → chip vanishes for 7 days
- [ ] Wait 7 days, reload → chip returns
- [ ] LS: `forge:<name>:passkeyNudge.createdAt` set on profile claim, `snoozedUntil` set on dismiss

**Home — card phase:**

- [ ] After 4 days from claim (or simulate by editing `createdAt` in DevTools to be 5 days ago) → chip is replaced by sage card with "Without one, your data lives only on this device" copy
- [ ] Tap card button → same OS prompt + success flow as chip
- [ ] Tap ✕ → 7-day snooze, card returns after that

**Edge cases:**

- [ ] Profile with passkey already set → no nudge, ever (regardless of `pnStage` value)
- [ ] Multiple profile switching → each profile's nudge state is independent (LS keyed by profile)

## What's next

Nothing on the polish queue. Ready for May launch.

The two queued items (copy polish + passkey nudge) are both addressed: copy was already solid, passkey nudge ships in this patch. Future work:

- Retrospective logging is already shipped (post-launch trigger criteria in earlier README — 2+ users complaining)
- Phase 5+ ML-driven adjustments (long-tail, post-data)
- Performance Lab volume visualisations (turn on Phase 4's silent infrastructure)
- Rep-range cycling logic

All post-launch.
