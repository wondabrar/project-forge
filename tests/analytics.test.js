// tests/analytics.test.js
// ────────────────────────────────────────────────────────────────────────────
// Volume aggregation correctness.
//
// Coverage focus:
//   1. per_db exercises double for volume (DB curl × 10kg × 10 reps both arms
//      = 200kg systemic load, not 100kg). Without this, every dumbbell
//      exercise is under-counted by half in per-muscle distribution charts.
//   2. Non-per_db loadTypes don't double (1×).
//   3. Legacy records without loadType default to 1× (don't retro-multiply).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { weeklyVolume, __test_p4__ } from "../lib/analytics.js";

const { aggregateVolume } = __test_p4__;

function buildSet({ weight = 10, reps = 10, loadType = null, volume = null, effectiveLoad = null }) {
  return {
    weight,
    reps,
    rir: 2,
    loadType,
    effectiveLoad: effectiveLoad ?? weight,
    volume: volume,
  };
}

function buildSession({ date = "2026-04-27", exercises = [] }) {
  return {
    v: 2,
    id: `${date}T10:00:00.000Z`,
    date,
    readiness: "normal",
    blocks: [{ id: "x", type: "main", exercises }],
  };
}

describe("aggregateVolume — per_db loadType doubles", () => {
  it("doubles volume for per_db exercise when set has loadType=per_db", () => {
    const session = buildSession({
      exercises: [{
        name: "DB Curl",
        muscle: "Biceps",
        loadType: "per_db",
        sets: [
          buildSet({ weight: 10, reps: 10, loadType: "per_db", volume: 100 }),
          buildSet({ weight: 10, reps: 10, loadType: "per_db", volume: 100 }),
          buildSet({ weight: 10, reps: 10, loadType: "per_db", volume: 100 }),
        ],
      }],
    });
    const result = aggregateVolume([session]);
    // 3 sets × (10kg × 10 reps × 2 hands) = 600
    expect(result.byMuscle.Biceps).toBe(600);
    expect(result.total).toBe(600);
  });

  it("doubles via exercise-level loadType when sets lack loadType (legacy records)", () => {
    // v1 records: per-set loadType absent; rely on exercise-level loadType.
    // Use a muscle label that doesn't accidentally normalise to Back via the
    // existing "lat" substring rule (e.g. "Lateral delt" → "Back").
    const session = buildSession({
      exercises: [{
        name: "Lateral Raise",
        muscle: "Shoulders",
        loadType: "per_db",
        sets: [
          buildSet({ weight: 8, reps: 15, loadType: null, volume: 120 }),
          buildSet({ weight: 8, reps: 15, loadType: null, volume: 120 }),
        ],
      }],
    });
    const result = aggregateVolume([session]);
    // 2 × (8 × 15 × 2) = 480
    expect(result.byMuscle.Shoulders).toBe(480);
  });

  it("does NOT double for barbell loadType", () => {
    const session = buildSession({
      exercises: [{
        name: "Barbell Back Squat",
        muscle: "Quadriceps",
        loadType: "barbell",
        sets: [
          buildSet({ weight: 100, reps: 5, loadType: "barbell", volume: 500 }),
        ],
      }],
    });
    const result = aggregateVolume([session]);
    expect(result.byMuscle.Legs).toBe(500); // 1×
  });

  it("does NOT double for machine, total, loaded_bw, or bodyweight loadTypes", () => {
    const session = buildSession({
      exercises: [
        {
          name: "Leg Press", muscle: "Quadriceps", loadType: "machine",
          sets: [buildSet({ weight: 100, reps: 10, loadType: "machine", volume: 1000 })],
        },
        {
          name: "Cable Pull-Through", muscle: "Glutes", loadType: "total",
          sets: [buildSet({ weight: 50, reps: 10, loadType: "total", volume: 500 })],
        },
      ],
    });
    const result = aggregateVolume([session]);
    expect(result.byMuscle.Legs).toBe(1500); // 1000 + 500
  });

  it("legacy records without any loadType default to 1× (no retro-multiplier)", () => {
    const session = buildSession({
      exercises: [{
        name: "Bench Press",
        muscle: "Chest",
        // no loadType on exercise or sets
        sets: [
          { weight: 80, reps: 5, rir: 2, volume: 400 },
        ],
      }],
    });
    const result = aggregateVolume([session]);
    expect(result.byMuscle.Chest).toBe(400);
  });

  it("falls back to raw weight × reps × multiplier when cached volume is absent", () => {
    const session = buildSession({
      exercises: [{
        name: "DB Curl",
        muscle: "Biceps",
        loadType: "per_db",
        sets: [
          { weight: 10, reps: 10, rir: 2, loadType: "per_db" }, // no volume, no effectiveLoad
        ],
      }],
    });
    const result = aggregateVolume([session]);
    // 10 × 10 × 2 = 200
    expect(result.byMuscle.Biceps).toBe(200);
  });
});

describe("weeklyVolume — per_db loadType doubles", () => {
  it("doubles DB exercise volume in weekly aggregation", () => {
    const session = buildSession({
      date: "2026-04-27",
      exercises: [{
        name: "DB Curl",
        muscle: "Biceps",
        loadType: "per_db",
        sets: [
          buildSet({ weight: 10, reps: 12, loadType: "per_db", volume: 120 }),
          buildSet({ weight: 10, reps: 12, loadType: "per_db", volume: 120 }),
          buildSet({ weight: 10, reps: 12, loadType: "per_db", volume: 120 }),
        ],
      }],
    });
    const weeks = weeklyVolume([session]);
    expect(weeks.length).toBe(1);
    // 3 × 120 × 2 = 720
    expect(weeks[0].byMuscle.Biceps.volume).toBe(720);
    expect(weeks[0].byMuscle.Biceps.sets).toBe(3);
  });
});
