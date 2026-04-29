// tests/progression.test.js
// ────────────────────────────────────────────────────────────────────────────
// Unit tests for the progression engine. The engine is the single most
// load-bearing piece of business logic in Forge — a regression here silently
// rolls back user progression for weeks before anyone notices.
//
// Coverage focus:
//   1. Cold start — first session, no history, no anchor; fallback to anchor
//   2. Decision tree — each ADD/HOLD/DROP path with realistic preconditions
//   3. RIR thresholds per category — power vs lower vs accessory vs isolation
//   4. Cooked override — readiness=cooked must never trigger ADD
//   5. State transitions — updateLiftStateFromSession produces expected shape
//   6. Phase 3 — deload signal detection, prescription scaling, recovery
//   7. Edge cases — null history, missing fields, parse failures
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  computeNextPrescription,
  updateLiftStateFromSession,
  // Phase 3
  detectDeloadSignals,
  shouldOfferDeload,
  computeDeloadPrescription,
  computeRecoveryPrescription,
  startDeload,
  completeDeload,
  dismissDeloadOffer,
  decrementRecoveryCounter,
  shouldAutoCompleteDeload,
  deloadCardCopy,
  deloadDayLabel,
  __test__,
  __test_p3__,
} from "../lib/progression.js";

// ─── Test helpers ───────────────────────────────────────────────────────────
function buildSet({ weight = 100, reps = 5, rir = 2, effectiveLoad = null, volume = null }) {
  return {
    weight,
    reps,
    rir,
    effectiveLoad: effectiveLoad ?? weight,
    volume: volume ?? weight * reps,
  };
}

function buildExercise({ name = "Barbell Back Squat", sets = [buildSet({})], muscle = "Quadriceps", prescribed = null }) {
  // prescribed is required by evaluatePerformance to know the target reps;
  // if not provided, we infer from the first set so tests of "user hit reps"
  // work without ceremony. Tests of "user missed reps" must pass prescribed
  // explicitly so the engine knows what was being aimed for.
  const inferredPrescribed = prescribed || {
    sets: sets.length,
    reps: sets[0]?.reps ?? 5,
    weight: sets[0]?.weight ?? null,
  };
  return {
    name,
    muscle,
    sets,
    prescribed: inferredPrescribed,
    summary: {
      totalVolume: sets.reduce((s, x) => s + (x.volume || 0), 0),
      topSet: sets[0],
    },
  };
}

function buildSession({
  id = "2026-04-27T10:00:00.000Z",
  date = "2026-04-27",
  readiness = "normal",
  exercises = [buildExercise({})],
  retrospective = false,
}) {
  return {
    v: 2,
    id,
    date,
    readiness,
    retrospective,
    blocks: [{ id: "a1", type: "main", exercises }],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Cold start — first session, no history
// ────────────────────────────────────────────────────────────────────────────
describe("computeNextPrescription — cold start", () => {
  it("returns COLD_START when no history and no liftState", () => {
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [],
      liftState: null,
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 60 },
    });
    expect(result.decision).toBe("COLD_START");
    expect(result.weight).toBe(60); // fall back to currentWeight
  });

  it("uses muscleAnchor for cold start when anchor lift is known", () => {
    const result = computeNextPrescription({
      liftName: "Pec Deck",
      history: [],
      liftState: null,
      muscleAnchor: { bestE1RM: 95, bestE1RMLift: "Barbell Bench Press" },
      context: { readiness: "normal", currentWeight: null },
    });
    // Pec Deck factor 0.25, applied to 75% of e1RM (~71kg) = 17.8 → rounds to ~18
    expect(result.weight).toBeGreaterThan(15);
    expect(result.weight).toBeLessThan(22);
    expect(result.decision).toBe("COLD_START");
  });

  it("returns currentWeight when neither history nor anchor available", () => {
    const result = computeNextPrescription({
      liftName: "Random New Lift",
      history: [],
      liftState: null,
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 40 },
    });
    expect(result.weight).toBe(40);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Decision tree — ADD / HOLD / DROP with realistic preconditions
// ────────────────────────────────────────────────────────────────────────────
describe("computeNextPrescription — decision tree", () => {
  // Helper to construct lift state representing a recent successful session
  const buildLiftState = ({ currentWeight = 100, prescribedReps = 5, prescribedSets = 3, e1RM = 117 }) => ({
    currentWeight,
    currentRepRange: { reps: prescribedReps, sets: prescribedSets },
    bestE1RM: e1RM,
    consecutiveHolds: 0,
    stallSignal: null,
    history: [],
  });

  it("ADDs when user hits all reps with RIR >= category threshold (lower compound)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [buildSet({ weight: 100, reps: 5, rir: 3 })], // RIR 3 — clearly more in tank
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("ADD");
    expect(result.weight).toBe(102.5); // +2.5 for lower_compound
  });

  it("HOLDs when user hits reps but at RIR 1 (close to limit)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [buildSet({ weight: 100, reps: 5, rir: 1 })],
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD");
    expect(result.weight).toBe(100);
  });

  it("HOLDs when user hits reps at RIR 0 (max effort)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [buildSet({ weight: 100, reps: 5, rir: 0 })],
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD");
  });

  it("HOLDs when user missed by 1 rep (light miss)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [buildSet({ weight: 100, reps: 4, rir: 0 })], // prescribed 5, hit 4
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD");
  });

  it("DROP_5 when user missed by 2 reps (moderate miss)", () => {
    // Prescribed: 3 sets of 5 = 15 reps target. User did 1 set of 3 = 3 reps,
    // missed 2 sets entirely. totalShortfall = 2 + 5 + 5 = 12, ratio = 0.80.
    // BUT > 0.30 → MISSED_HEAVY → DROP_10. So a single set of 3 reps is too
    // sparse for MISSED_MODERATE. Need 3 sets, each missing slightly.
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [
          buildSet({ weight: 100, reps: 4, rir: 0 }), // missed by 1
          buildSet({ weight: 100, reps: 4, rir: 0 }), // missed by 1
          buildSet({ weight: 100, reps: 3, rir: 0 }), // missed by 2 — total 4
        ],
        prescribed: { sets: 3, reps: 5, weight: 100 },
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("DROP_5");
    expect(result.weight).toBe(95); // 100 × 0.95 → 95kg
  });

  it("DROP_10 when user missed badly (heavy miss)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [
          buildSet({ weight: 100, reps: 2, rir: 0 }), // -3
          buildSet({ weight: 100, reps: 1, rir: 0 }), // -4
          buildSet({ weight: 100, reps: 0, rir: 0 }), // -5 → totalShortfall=12, ratio=0.80
        ],
        prescribed: { sets: 3, reps: 5, weight: 100 },
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: buildLiftState({}),
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result.decision).toBe("DROP_10");
    expect(result.weight).toBe(90); // 100 × 0.90
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Category-specific RIR thresholds
// ────────────────────────────────────────────────────────────────────────────
describe("computeNextPrescription — category thresholds", () => {
  it("Power Clean requires RIR >= 3 to ADD (power category)", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Power Clean",
        muscle: "Full body / explosive",
        sets: [buildSet({ weight: 60, reps: 3, rir: 2 })], // RIR 2 — would ADD for compound, not for power
      })],
    });
    const result = computeNextPrescription({
      liftName: "Power Clean",
      history: [lastSession],
      liftState: { currentWeight: 60, currentRepRange: { reps: 3, sets: 3 }, bestE1RM: 70, consecutiveHolds: 0, stallSignal: null, history: [] },
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 60 },
    });
    expect(result.decision).toBe("HOLD"); // not enough margin for power
  });

  it("Power Clean ADDs at RIR 3", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Power Clean",
        muscle: "Full body / explosive",
        sets: [buildSet({ weight: 60, reps: 3, rir: 3 })],
      })],
    });
    const result = computeNextPrescription({
      liftName: "Power Clean",
      history: [lastSession],
      liftState: { currentWeight: 60, currentRepRange: { reps: 3, sets: 3 }, bestE1RM: 70, consecutiveHolds: 0, stallSignal: null, history: [] },
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 60 },
    });
    expect(result.decision).toBe("ADD");
    expect(result.weight).toBe(62.5); // +2.5 for power
  });

  it("Lateral Raise (isolation) ADDs by 0.5kg", () => {
    const lastSession = buildSession({
      exercises: [buildExercise({
        name: "Lateral Raise",
        muscle: "Side delts",
        sets: [buildSet({ weight: 10, reps: 12, rir: 2 })],
      })],
    });
    const result = computeNextPrescription({
      liftName: "Lateral Raise",
      history: [lastSession],
      liftState: { currentWeight: 10, currentRepRange: { reps: 12, sets: 3 }, bestE1RM: 12, consecutiveHolds: 0, stallSignal: null, history: [] },
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 10 },
    });
    expect(result.decision).toBe("ADD");
    expect(result.weight).toBe(10.5); // +0.5 for isolation
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Cooked override — readiness="cooked" must never ADD
// ────────────────────────────────────────────────────────────────────────────
describe("computeNextPrescription — cooked override", () => {
  // The cooked override is conservative-by-design: a cooked session is
  // assumed to not reflect the user's true performance, so the engine
  // falls back to HOLD regardless of what numbers were logged. Two effects:
  //   1. Cooked sessions don't trigger ADD even on great numbers
  //   2. Cooked sessions don't trigger DROP on bad numbers either
  // The latter is debatable — a user who's cooked AND missing reps is
  // arguably in trouble — but the current contract is "cooked = ignore
  // performance, hold steady." This test locks in that contract.

  it("HOLDs when readiness=cooked, even with full reps + good RIR", () => {
    // Note: `findMostRecentLiftSession` skips cooked sessions when looking
    // for last performance. So a cooked session in history is invisible to
    // the next prescription's lookback. To test the cooked override we need
    // a CLEAN session in history + context.readiness="cooked" passed in.
    const cleanSession = buildSession({
      readiness: "normal",
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [buildSet({ weight: 100, reps: 5, rir: 3 })],
        prescribed: { sets: 1, reps: 5, weight: 100 },
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [cleanSession],
      liftState: { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 0, stallSignal: null, history: [] },
      muscleAnchor: null,
      context: { readiness: "cooked", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD");
    expect(result.weight).toBe(100);
    // Engine writes "decision_reason=readiness_cooked" into rationale
    expect(result.rationale.some(r => r.includes("readiness_cooked"))).toBe(true);
  });

  it("HOLDs (does NOT drop) even when last session shows missed reps if context=cooked", () => {
    // Documents that the cooked override blocks drops too — a deliberate
    // contract choice. If you want this to drop instead, that's a real
    // engine change to discuss separately.
    const lastSession = buildSession({
      readiness: "normal",
      exercises: [buildExercise({
        name: "Barbell Back Squat",
        sets: [
          buildSet({ weight: 100, reps: 2, rir: 0 }),
          buildSet({ weight: 100, reps: 1, rir: 0 }),
          buildSet({ weight: 100, reps: 0, rir: 0 }),
        ],
        prescribed: { sets: 3, reps: 5, weight: 100 },
      })],
    });
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [lastSession],
      liftState: { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 0, stallSignal: null, history: [] },
      muscleAnchor: null,
      context: { readiness: "cooked", currentWeight: 100 },
    });
    expect(result.decision).toBe("HOLD"); // cooked wins — no drop
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. State transitions — updateLiftStateFromSession
// ────────────────────────────────────────────────────────────────────────────
describe("updateLiftStateFromSession", () => {
  it("returns a new liftState with appended history entry, currentWeight tracks what was performed", () => {
    const initial = { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 0, stallSignal: null, history: [] };
    const session = buildSession({});
    const exercise = session.blocks[0].exercises[0];
    const prescription = { weight: 102.5, reps: 5, sets: 3, rir: 2, decision: "ADD", rationale: ["full_reps_with_margin"] };

    const next = updateLiftStateFromSession(initial, session, exercise, prescription);
    // currentWeight reflects what was JUST lifted in the session (100kg), not the
    // prescription for next time (102.5kg). The "next prescription" lives in
    // ForgeApp's workingWeights map, separately. This separation matters because
    // the engine reads currentWeight as "user's current strength" not "next target".
    expect(next.currentWeight).toBe(100);
    expect(next.history).toHaveLength(1);
    expect(next.history[0].decision).toBe("ADD");
    expect(next.consecutiveHolds).toBe(0);
  });

  it("increments consecutiveHolds on HOLD decision", () => {
    const initial = { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 1, stallSignal: null, history: [] };
    const session = buildSession({});
    const exercise = session.blocks[0].exercises[0];
    const prescription = { weight: 100, reps: 5, sets: 3, rir: 2, decision: "HOLD", rationale: ["rir_too_low"] };

    const next = updateLiftStateFromSession(initial, session, exercise, prescription);
    expect(next.consecutiveHolds).toBe(2);
  });

  it("sets stallSignal=stall after 3+ consecutive holds", () => {
    const initial = { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 2, stallSignal: null, history: [] };
    const session = buildSession({});
    const exercise = session.blocks[0].exercises[0];
    const prescription = { weight: 100, reps: 5, sets: 3, rir: 2, decision: "HOLD", rationale: ["rir_too_low"] };

    const next = updateLiftStateFromSession(initial, session, exercise, prescription);
    expect(next.consecutiveHolds).toBe(3);
    expect(next.stallSignal).toBe("stall");
  });

  it("caps history at 12 entries (rolling window)", () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ date: `2026-04-${i+1}`, decision: "HOLD" }));
    const initial = { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 }, bestE1RM: 117, consecutiveHolds: 0, stallSignal: null, history: long };
    const session = buildSession({});
    const exercise = session.blocks[0].exercises[0];
    const prescription = { weight: 102.5, reps: 5, sets: 3, rir: 2, decision: "ADD", rationale: ["full_reps_with_margin"] };

    const next = updateLiftStateFromSession(initial, session, exercise, prescription);
    expect(next.history).toHaveLength(12); // capped
    expect(next.history[11].decision).toBe("ADD"); // newest at end
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Phase 3 — Deload signals
// ────────────────────────────────────────────────────────────────────────────
describe("Phase 3 — detectDeloadSignals", () => {
  it("returns empty array on fresh state", () => {
    expect(detectDeloadSignals({ lifts: {}, mesocycle: {} }, [])).toEqual([]);
  });

  it("detects stall convergence when 2+ lifts are stalled", () => {
    const ts = {
      lifts: {
        "Squat": { stallSignal: "stall" },
        "Bench": { stallSignal: "stall" },
      },
      mesocycle: { deloadSignals: {} },
    };
    const sigs = detectDeloadSignals(ts, []);
    expect(sigs.length).toBe(1);
    expect(sigs[0].type).toBe("stall_convergence");
  });

  it("detects deep_stall on a single lift with 4+ holds", () => {
    const ts = {
      lifts: {
        "Squat": { stallSignal: "deep_stall", consecutiveHolds: 4 },
      },
      mesocycle: { deloadSignals: {} },
    };
    const sigs = detectDeloadSignals(ts, []);
    expect(sigs.length).toBe(1);
    expect(sigs[0].type).toBe("deep_stall");
  });
});

describe("Phase 3 — shouldOfferDeload cooldowns", () => {
  it("respects 14-day cooldown after completion", () => {
    const recent = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const ts = {
      lifts: { "Squat": { stallSignal: "stall" }, "Bench": { stallSignal: "stall" } },
      mesocycle: { deloadSignals: { lastDeloadCompletedAt: recent } },
    };
    expect(shouldOfferDeload(ts, [])).toBe(null); // within cooldown
  });

  it("respects 5-day cooldown after dismiss", () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const ts = {
      lifts: { "Squat": { stallSignal: "stall" }, "Bench": { stallSignal: "stall" } },
      mesocycle: { deloadSignals: { lastOfferDismissedAt: recent } },
    };
    expect(shouldOfferDeload(ts, [])).toBe(null);
  });

  it("returns signal when cooldowns expired AND signals present", () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const ts = {
      lifts: { "Squat": { stallSignal: "stall" }, "Bench": { stallSignal: "stall" } },
      mesocycle: { deloadSignals: { lastDeloadCompletedAt: old } },
    };
    expect(shouldOfferDeload(ts, [])).not.toBe(null);
  });
});

describe("Phase 3 — computeDeloadPrescription", () => {
  it("scales main lift to 65% with 2 sets", () => {
    const result = computeDeloadPrescription("Barbell Back Squat", {
      currentWeight: 100,
      currentRepRange: { reps: 5, sets: 3 },
    }, {});
    expect(result.weight).toBe(65);
    expect(result.sets).toBe(2);
    expect(result.decision).toBe("DELOAD");
  });

  it("scales accessory to 70% with 2 sets", () => {
    const result = computeDeloadPrescription("Lateral Raise", {
      currentWeight: 10,
      currentRepRange: { reps: 12, sets: 3 },
    }, {});
    expect(result.weight).toBe(7);
    expect(result.sets).toBe(2);
  });

  it("scales power lift to 60% (rounds to nearest 1.25kg plate)", () => {
    const result = computeDeloadPrescription("Power Clean", {
      currentWeight: 60,
      currentRepRange: { reps: 3, sets: 3 },
    }, {});
    // 60 × 0.60 = 36.0, rounds to nearest 1.25 plate → 36.25kg.
    // The 1.25kg increment is correct: deload weights still need to be loadable.
    expect(result.weight).toBe(36.25);
  });
});

describe("Phase 3 — startDeload + completeDeload + dismissDeloadOffer", () => {
  it("startDeload creates activeDeload subtree, snapshots preDeloadWeights map", () => {
    const ts = {
      lifts: { "Squat": { currentWeight: 100, stallSignal: "stall" } },
      mesocycle: { deloadSignals: {} },
    };
    const signal = { type: "stall_convergence", detectedAt: new Date().toISOString(), severity: 0.7 };
    const next = startDeload(ts, signal);
    expect(next.mesocycle.activeDeload).toBeTruthy();
    expect(next.mesocycle.activeDeload.plannedDays).toBe(5);
    // preDeloadWeights is a map keyed by lift name on the mesocycle subtree,
    // NOT a per-lift field. This is so completeDeload() can rebuild from a
    // single source rather than walking every lift's individual snapshot.
    expect(next.mesocycle.activeDeload.preDeloadWeights.Squat).toBe(100);
  });

  it("completeDeload clears activeDeload and sets inRecoveryUntil per lift", () => {
    const ts = {
      lifts: { "Squat": { currentWeight: 65, preDeloadWeight: 100, stallSignal: "stall" } },
      mesocycle: { activeDeload: { startedAt: "x", plannedDays: 5 }, deloadSignals: {} },
    };
    const next = completeDeload(ts);
    expect(next.mesocycle.activeDeload).toBe(null);
    expect(next.mesocycle.deloadSignals.lastDeloadCompletedAt).toBeTruthy();
    expect(next.lifts.Squat.inRecoveryUntil).toBe(3); // 3 recovery sessions per lift
  });

  it("dismissDeloadOffer sets lastOfferDismissedAt without changing lifts", () => {
    const ts = {
      lifts: { "Squat": { currentWeight: 100 } },
      mesocycle: { deloadSignals: {} },
    };
    const next = dismissDeloadOffer(ts);
    expect(next.mesocycle.deloadSignals.lastOfferDismissedAt).toBeTruthy();
    expect(next.lifts.Squat.currentWeight).toBe(100); // untouched
  });
});

describe("Phase 3 — shouldAutoCompleteDeload", () => {
  it("returns true when current session is >= 4 days after deload start", () => {
    const ts = {
      mesocycle: {
        activeDeload: { startedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
      },
    };
    const sessionDate = new Date().toISOString().slice(0, 10);
    expect(shouldAutoCompleteDeload(ts, sessionDate)).toBe(true);
  });

  it("returns false when within the 4-day window", () => {
    const ts = {
      mesocycle: {
        activeDeload: { startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
      },
    };
    const sessionDate = new Date().toISOString().slice(0, 10);
    expect(shouldAutoCompleteDeload(ts, sessionDate)).toBe(false);
  });

  it("returns false when no active deload", () => {
    expect(shouldAutoCompleteDeload({ mesocycle: {} }, "2026-04-27")).toBe(false);
  });
});

describe("Phase 3 — computeRecoveryPrescription", () => {
  it("rebuilds at 110% of deloaded weight (rounds to nearest 1.25kg plate)", () => {
    const liftState = {
      currentWeight: 65, // deloaded
      preDeloadWeight: 100,
      currentRepRange: { reps: 5, sets: 3 },
      inRecoveryUntil: 3,
    };
    const result = computeRecoveryPrescription("Barbell Back Squat", liftState, [], {});
    // 65 × 1.10 = 71.5, rounds to nearest 1.25 plate → 71.25kg.
    expect(result.weight).toBe(71.25);
    expect(result.decision).toBe("RECOVERY");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. Edge cases — defensive paths
// ────────────────────────────────────────────────────────────────────────────
describe("computeNextPrescription — edge cases", () => {
  it("handles null history gracefully", () => {
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: null,
      liftState: null,
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result).toBeTruthy();
    expect(result.weight).toBe(100); // falls back to currentWeight
  });

  it("handles missing context.readiness", () => {
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [],
      liftState: null,
      muscleAnchor: null,
      context: { currentWeight: 100 },
    });
    expect(result).toBeTruthy();
  });

  it("handles undefined liftState fields without throwing", () => {
    const result = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [],
      liftState: { currentWeight: 100 }, // missing most fields
      muscleAnchor: null,
      context: { readiness: "normal", currentWeight: 100 },
    });
    expect(result).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. Internal helpers (via __test__ export)
// ────────────────────────────────────────────────────────────────────────────
describe("Internal helpers (__test__)", () => {
  it("parseReps handles plain integer", () => {
    expect(__test__.parseReps(5)).toBe(5);
    expect(__test__.parseReps("8")).toBe(8);
  });

  it("parseReps handles unilateral notation", () => {
    expect(__test__.parseReps("8/leg")).toBe(8);
    expect(__test__.parseReps("10/side")).toBe(10);
  });

  it("topSetRir returns the RIR of the heaviest set", () => {
    const ex = buildExercise({
      sets: [
        buildSet({ weight: 90, reps: 5, rir: 3 }),
        buildSet({ weight: 100, reps: 5, rir: 1 }), // heaviest
        buildSet({ weight: 95, reps: 5, rir: 2 }),
      ],
    });
    expect(__test__.topSetRir(ex)).toBe(1);
  });
});
