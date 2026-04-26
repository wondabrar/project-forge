// lib/progression.js
// ─────────────────────────────────────────────────────────────────────────────
// The progression engine.
//
// Single entry point: computeNextPrescription(...)
// Pure function — no React, no I/O. Takes session history + lift state +
// optional context, returns the next prescription for that lift.
//
// Decision tree (per main lift, and per accessory with smaller step):
//
//   COLD START (no prior session for this lift):
//     - If muscle anchor exists → use coldStartFromAnchor()
//     - Otherwise → fall back to programme.js default weight
//
//   FOLLOWING SESSION 1+:
//     Look at the most recent session's top set vs prescribed target.
//
//     PERFORMED ALL prescribed reps + RIR ≥ category threshold (typ. 2)
//       → ADD: nextWeight = currentWeight + step
//
//     PERFORMED ALL prescribed reps + RIR 1
//       → HOLD: nextWeight = currentWeight, advance rep target
//
//     PERFORMED ALL prescribed reps + RIR 0
//       → HOLD: tough grinder, hold and re-test
//
//     MISSED 1 rep on last set (e.g. 5/5/4 vs 5×3)
//       → HOLD
//
//     MISSED reps on multiple sets, or shortfall ≤ 30% total reps
//       → DROP 5%
//
//     MISSED reps badly (shortfall > 30% total)
//       → DROP 10%, regress
//
//   FATIGUE OVERRIDE:
//     If last session was readiness=cooked, downgrade ADD → HOLD.
//     (Other fatigue checks deliberately omitted — ballerina waistline.)
//
// ─────────────────────────────────────────────────────────────────────────────

import { getLiftProfile, STEP_SIZES, ADD_THRESHOLD_RIR, coldStartFromAnchor } from "./lift-translations.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_REPS = 5;
const DEFAULT_SETS = 3;
const DEFAULT_RIR  = 2;

// ─── Numeric reps parser (mirrors storage.js) ─────────────────────────────────
function parseReps(reps) {
  if (typeof reps === "number") return reps;
  if (typeof reps === "string") {
    const m = reps.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  return 0;
}

// Round to plate increment based on category
function roundToCategoryIncrement(weight, category) {
  if (weight === null || weight === undefined) return weight;
  const increment = (
    category === "accessory_arm" ||
    category === "accessory_isolation"
  ) ? 0.5 : 1.25;
  return Math.round(weight / increment) * increment;
}

// ─── Find the most recent session of a given lift in history ──────────────────
// Iterates v2-shape session history (newest last by ID sort) and returns the
// most recent session containing the lift, plus the exercise object within it.
//
// Skips sessions where readiness === "cooked" by default — those don't drive
// progression decisions (they're recovery sessions).
function findMostRecentLiftSession(history, liftName, { includeCooked = false } = {}) {
  if (!history || !history.length) return null;

  // Iterate newest-first
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i];
    if (!includeCooked && rec.readiness === "cooked") continue;

    for (const block of rec.blocks || []) {
      for (const ex of block.exercises || []) {
        if (ex.name === liftName) {
          return { session: rec, exercise: ex, blockType: block.type };
        }
      }
    }
  }
  return null;
}

// ─── Evaluate a session's performance against its prescribed target ──────────
// Returns one of:
//   "PERFORMED_FULL"  — hit all prescribed reps across all sets
//   "MISSED_LIGHT"    — missed reps on one set only
//   "MISSED_MODERATE" — missed across multiple sets, ≤ 30% shortfall
//   "MISSED_HEAVY"    — > 30% shortfall (badly missed session)
//
// Considers `prescribed` if present on the exercise; falls back to per-set
// rep targets derived from the first set if not.
function evaluatePerformance(exercise) {
  const sets = (exercise.sets || []).filter(s => s.reps !== null && s.reps !== undefined);
  if (sets.length === 0) return "PERFORMED_FULL"; // No data — neutral

  // Determine target reps per set
  let targetSets = sets.length;
  let targetReps;
  if (exercise.prescribed && exercise.prescribed.reps) {
    targetReps = parseReps(exercise.prescribed.reps);
    if (exercise.prescribed.sets) targetSets = exercise.prescribed.sets;
  } else {
    // No prescribed — use the first set's reps as the implied target
    targetReps = parseReps(sets[0].reps);
  }
  if (!targetReps || targetReps === 0) return "PERFORMED_FULL";

  // Count missed-rep sets and total shortfall
  let missedSetCount = 0;
  let totalShortfall = 0;
  const totalTargetReps = targetSets * targetReps;
  let actualReps = 0;

  for (let i = 0; i < targetSets; i++) {
    const set = sets[i];
    const performed = set ? parseReps(set.reps) : 0;
    actualReps += performed;
    const shortfall = Math.max(0, targetReps - performed);
    if (shortfall > 0) missedSetCount += 1;
    totalShortfall += shortfall;
  }

  if (missedSetCount === 0) return "PERFORMED_FULL";
  if (missedSetCount === 1 && totalShortfall <= Math.ceil(targetReps * 0.4)) {
    return "MISSED_LIGHT"; // One set short by a small amount
  }
  const shortfallRatio = totalShortfall / totalTargetReps;
  if (shortfallRatio > 0.30) return "MISSED_HEAVY";
  return "MISSED_MODERATE";
}

// ─── Get the top-set RIR for a session's exercise ─────────────────────────────
// Returns the lowest RIR seen across the exercise's sets (the "hardest" set).
// Lower RIR = closer to limit. We use this rather than average because the top
// set is the most diagnostic of progression readiness.
function topSetRir(exercise) {
  const sets = (exercise.sets || []).filter(s => s.rir !== null && s.rir !== undefined);
  if (sets.length === 0) return null;
  return Math.min(...sets.map(s => s.rir));
}

// ─── Get the top-set effective load ──────────────────────────────────────────
// Returns the heaviest set's effectiveLoad if available (reflects true systemic
// load including bodyweight for non-external lifts).
function topSetWeight(exercise, fallbackWeight) {
  const sets = exercise.sets || [];
  if (sets.length === 0) return fallbackWeight;
  // Prefer effectiveLoad (Phase 0.5+); fall back to raw weight
  const loads = sets.map(s => s.effectiveLoad ?? s.weight ?? 0);
  return Math.max(...loads, fallbackWeight ?? 0) || fallbackWeight;
}

// ─── Decide ADD / HOLD / DROP based on performance + RIR ─────────────────────
function decideMovement(performance, rir, addThresholdRir, readiness) {
  // Cooked sessions: never add weight, never drop further. Just hold.
  if (readiness === "cooked") {
    return { decision: "HOLD", reason: "readiness_cooked" };
  }

  // Performance gate: ADD requires hitting prescribed reps
  if (performance === "PERFORMED_FULL") {
    if (rir === null) {
      // No RIR signal — be conservative, hold
      return { decision: "HOLD", reason: "no_rir_signal" };
    }
    if (rir >= addThresholdRir) {
      return { decision: "ADD", reason: "performed_full_with_rir" };
    }
    if (rir === 0) {
      // True grinder — held but at absolute limit
      return { decision: "HOLD", reason: "performed_full_rir0_grinder" };
    }
    if (rir === 1) {
      return { decision: "HOLD", reason: "performed_full_rir1_close_to_limit" };
    }
    // RIR is between 1 and the addThreshold — sub-threshold for this category
    return { decision: "HOLD", reason: "performed_full_subthreshold_rir" };
  }

  if (performance === "MISSED_LIGHT") {
    return { decision: "HOLD", reason: "missed_light" };
  }
  if (performance === "MISSED_MODERATE") {
    return { decision: "DROP_5", reason: "missed_moderate" };
  }
  if (performance === "MISSED_HEAVY") {
    return { decision: "DROP_10", reason: "missed_heavy" };
  }

  // Unknown — be conservative
  return { decision: "HOLD", reason: "unknown_state" };
}

// ─── Apply movement to last weight, returning the next prescription ──────────
function applyMovement(decision, currentWeight, category, profile) {
  const step = STEP_SIZES[category] ?? 0;
  let next;
  switch (decision) {
    case "ADD":
      next = currentWeight + step;
      break;
    case "HOLD":
      next = currentWeight;
      break;
    case "DROP_5":
      next = currentWeight * 0.95;
      break;
    case "DROP_10":
      next = currentWeight * 0.90;
      break;
    default:
      next = currentWeight;
  }
  // Floor at 0; round to category increment
  return Math.max(0, roundToCategoryIncrement(next, category));
}

// ─── Public API: computeNextPrescription ──────────────────────────────────────
// Returns a prescription object describing what the user should do on this lift
// next session. Pure function — caller persists the result to TS.lifts[name].
//
// args:
//   liftName       (string) canonical exercise name
//   history        (array)  session history, v2-shaped, oldest first
//   liftState      (object|null)  TS.lifts[liftName], or null on cold start
//   muscleAnchor   (object|null)  TS.muscleAnchors[muscleGroup], used for cold start
//   context        (object)  { readiness?, currentWeight? } — current session readiness, fallback weight
//
// returns:
//   {
//     weight,        // recommended weight for next session (kg, or null if BW-only)
//     reps,          // target reps
//     sets,          // target set count
//     rir,           // target RIR
//     decision,      // "COLD_START" | "ADD" | "HOLD" | "DROP_5" | "DROP_10"
//     rationale,     // string array — debug/diagnostic
//     confidence,    // "high" | "moderate" | "low"
//     repRangeChanged,    // false in v1, will be true when Phase 3 cycles
//   }
export function computeNextPrescription({
  liftName,
  history = [],
  liftState = null,
  muscleAnchor = null,
  context = {},
}) {
  const profile = getLiftProfile(liftName);
  const category = profile.category;
  const addThresholdRir = ADD_THRESHOLD_RIR[category] ?? DEFAULT_RIR;
  const rationale = [];

  // ─── Cold start ──────────────────────────────────────────────────────────
  // No prior history for this lift.
  const lastSession = findMostRecentLiftSession(history, liftName, { includeCooked: false });

  if (!lastSession || !liftState) {
    // BW-progression lifts get rep-based prescription, no weight
    if (!profile.progressesByLoad) {
      return {
        weight: null,
        reps: DEFAULT_REPS,
        sets: DEFAULT_SETS,
        rir: DEFAULT_RIR,
        decision: "COLD_START",
        rationale: ["bw_progression_no_weight"],
        confidence: "moderate",
        repRangeChanged: false,
      };
    }

    // Try anchor-based cold start
    const anchorWeight = coldStartFromAnchor(liftName, muscleAnchor);
    if (anchorWeight !== null) {
      rationale.push("cold_start_from_anchor");
      rationale.push(`anchor_lift=${muscleAnchor?.bestE1RMLift || "unknown"}`);
      return {
        weight: anchorWeight,
        reps: DEFAULT_REPS,
        sets: DEFAULT_SETS,
        rir: DEFAULT_RIR,
        decision: "COLD_START",
        rationale,
        confidence: "moderate",
        repRangeChanged: false,
      };
    }

    // No anchor available — caller falls back to programme.js default
    rationale.push("cold_start_no_anchor");
    return {
      weight: context.currentWeight ?? null, // caller provides programme default
      reps: DEFAULT_REPS,
      sets: DEFAULT_SETS,
      rir: DEFAULT_RIR,
      decision: "COLD_START",
      rationale,
      confidence: "low",
      repRangeChanged: false,
    };
  }

  // ─── Standard path — we have history for this lift ───────────────────────
  const lastEx = lastSession.exercise;
  const lastWeight = topSetWeight(lastEx, liftState.currentWeight);
  const performance = evaluatePerformance(lastEx);
  const rir = topSetRir(lastEx);
  const lastReadiness = lastSession.session.readiness;

  rationale.push(`last_performance=${performance}`);
  if (rir !== null) rationale.push(`top_set_rir=${rir}`);
  if (lastReadiness === "cooked") rationale.push("last_session_cooked");

  // BW-progression lifts: no weight change, but we can suggest rep progression
  if (!profile.progressesByLoad) {
    // Simple rep progression: if performed full + RIR ≥ 2, add 1 rep target
    const lastReps = parseReps(lastEx.sets?.[0]?.reps) || DEFAULT_REPS;
    const repsNext = (performance === "PERFORMED_FULL" && rir !== null && rir >= addThresholdRir)
      ? lastReps + 1
      : lastReps;
    rationale.push("bw_rep_progression");
    return {
      weight: null,
      reps: repsNext,
      sets: lastEx.prescribed?.sets ?? DEFAULT_SETS,
      rir: DEFAULT_RIR,
      decision: repsNext > lastReps ? "ADD" : "HOLD",
      rationale,
      confidence: "moderate",
      repRangeChanged: false,
    };
  }

  // Loaded progression
  const movement = decideMovement(performance, rir, addThresholdRir, context.readiness ?? lastReadiness);
  rationale.push(`decision_reason=${movement.reason}`);

  const nextWeight = applyMovement(movement.decision, lastWeight, category, profile);

  // Confidence calibration
  let confidence = "moderate";
  if (liftState && (liftState.sessionsCount ?? 0) >= 4) confidence = "high";
  if (liftState && (liftState.sessionsCount ?? 0) <= 1) confidence = "low";
  if (rir === null) confidence = "low";

  // Rep range — pulled from liftState if Phase 3 has cycled it; else default/last
  const currentRepRange = liftState.currentRepRange || {
    reps: parseReps(lastEx.prescribed?.reps) || parseReps(lastEx.sets?.[0]?.reps) || DEFAULT_REPS,
    sets: lastEx.prescribed?.sets ?? DEFAULT_SETS,
  };

  return {
    weight: nextWeight,
    reps: currentRepRange.reps,
    sets: currentRepRange.sets,
    rir: lastEx.prescribed?.rir ?? DEFAULT_RIR,
    decision: movement.decision,
    rationale,
    confidence,
    repRangeChanged: false, // Phase 3 will flip true on cycles
  };
}

// ─── Helper: derive updated lift state from a freshly finalised session ──────
// Caller computes `prescription` via computeNextPrescription, then calls this
// to get the new TS.lifts[liftName] value to persist.
//
// Usage at session finalise:
//   const prescription = computeNextPrescription({...});
//   const newState = updateLiftStateFromSession(liftState, sessionRecord, exercise, prescription);
//   TS.updateLift(profile, liftName, newState);
export function updateLiftStateFromSession(liftState, sessionRecord, exercise, prescription) {
  const profile = getLiftProfile(exercise.name);
  const sets = exercise.sets || [];
  const performed = sets.filter(s => s.weight !== null && s.weight !== undefined);
  const topSet = performed.reduce((best, s) => {
    if (!best) return s;
    return (s.est1rm || 0) > (best.est1rm || 0) ? s : best;
  }, null);

  const prevState = liftState || {
    currentWeight: null,
    nextPrescribed: null,
    e1RM: null,
    e1RMDate: null,
    sessionsCount: 0,
    sessionsSinceLastPR: 0,
    progressionProfile: profile.category,
    stallSignal: null,
    consecutiveHolds: 0,
    history: [],
    currentRepRange: null,
    repRangeHistory: [],
  };

  const sessionsCount = (prevState.sessionsCount ?? 0) + 1;
  let e1RM = prevState.e1RM;
  let e1RMDate = prevState.e1RMDate;
  let sessionsSinceLastPR = (prevState.sessionsSinceLastPR ?? 0) + 1;
  if (topSet && topSet.est1rm && (!e1RM || topSet.est1rm > e1RM)) {
    e1RM = topSet.est1rm;
    e1RMDate = sessionRecord.date;
    sessionsSinceLastPR = 0;
  }

  // Stall tracking — increment if HOLD, reset if ADD or DROP
  let consecutiveHolds = prevState.consecutiveHolds ?? 0;
  if (prescription.decision === "HOLD") consecutiveHolds += 1;
  else                                  consecutiveHolds = 0;

  // Compute stallSignal — input for Phase 3, dormant in v1
  let stallSignal = null;
  if (consecutiveHolds === 2)      stallSignal = "mild";
  else if (consecutiveHolds === 3) stallSignal = "stall";
  else if (consecutiveHolds >= 4)  stallSignal = "deep_stall";

  // History — capped at last 12 sessions
  const newHistoryEntry = {
    date: sessionRecord.date,
    weight: topSet?.weight ?? null,
    effectiveLoad: topSet?.effectiveLoad ?? null,
    reps: topSet?.reps ?? null,
    rir: topSet?.rir ?? null,
    est1rm: topSet?.est1rm ?? null,
    decision: prescription.decision,
    rationale: prescription.rationale,
  };
  const history = [...(prevState.history || []), newHistoryEntry].slice(-12);

  return {
    currentWeight: topSet?.weight ?? prevState.currentWeight,
    nextPrescribed: prescription.weight,
    e1RM,
    e1RMDate,
    sessionsCount,
    sessionsSinceLastPR,
    progressionProfile: profile.category,
    stallSignal,
    consecutiveHolds,
    history,
    // Rep range — preserve existing or seed from prescription
    currentRepRange: prevState.currentRepRange || { reps: prescription.reps, sets: prescription.sets },
    repRangeHistory: prevState.repRangeHistory || [],
  };
}

// ─── Helper: update muscle anchor from a finalised session ────────────────────
// Tracks the best e1RM hit on any lift in the muscle group, used for cold-start
// translations. Called once per exercise at session finalise.
//
// Returns updated muscleAnchor object — caller persists via TS.updateMuscleAnchor.
export function updateMuscleAnchorFromSession(currentAnchor, sessionRecord, exercise) {
  const profile = getLiftProfile(exercise.name);
  if (!profile.primaryMuscle) return currentAnchor; // unknown muscle — skip
  if (!profile.progressesByLoad) return currentAnchor; // BW lift — doesn't anchor

  const sets = exercise.sets || [];
  const topSet = sets.reduce((best, s) => {
    if (!best) return s;
    return (s.est1rm || 0) > (best.est1rm || 0) ? s : best;
  }, null);
  if (!topSet || !topSet.est1rm) return currentAnchor;

  // Translate this lift's e1RM to anchor-equivalent e1RM via inverse factor
  // e.g., goblet squat at 30kg with factor 0.35 → equivalent back squat ≈ 30/0.35 ≈ 86kg
  const factor = profile.factor || 1;
  if (factor === 0) return currentAnchor;
  const anchorEquivalentE1RM = topSet.est1rm / factor;

  const prev = currentAnchor || {
    bestE1RM: null,
    bestE1RMLift: null,
    bestE1RMDate: null,
    recentTopSets: [],
  };

  let bestE1RM = prev.bestE1RM;
  let bestE1RMLift = prev.bestE1RMLift;
  let bestE1RMDate = prev.bestE1RMDate;
  if (!bestE1RM || anchorEquivalentE1RM > bestE1RM) {
    bestE1RM = Math.round(anchorEquivalentE1RM * 10) / 10;
    bestE1RMLift = exercise.name;
    bestE1RMDate = sessionRecord.date;
  }

  // Append to rolling window (last 6)
  const recentTopSets = [
    ...(prev.recentTopSets || []),
    {
      date: sessionRecord.date,
      lift: exercise.name,
      weight: topSet.weight,
      reps: topSet.reps,
      effectiveLoad: topSet.effectiveLoad,
      est1rm: topSet.est1rm,
      anchorEquivalentE1RM: Math.round(anchorEquivalentE1RM * 10) / 10,
    },
  ].slice(-6);

  return {
    bestE1RM,
    bestE1RMLift,
    bestE1RMDate,
    recentTopSets,
  };
}

// Test exports
export const __test__ = {
  evaluatePerformance,
  topSetRir,
  topSetWeight,
  decideMovement,
  applyMovement,
  findMostRecentLiftSession,
  parseReps,
};
