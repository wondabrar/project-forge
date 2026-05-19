// tests/programme.test.js
// ────────────────────────────────────────────────────────────────────────────
// Programme data invariants.
//
// Coverage focus:
//   1. Pool[0] === SESSIONS default for every accessory/finisher slot —
//      drift here means rotation silently presents a different exercise on
//      Day 1 than the home screen shows. Caught a Standing Calf Raise
//      mismatch that survived a recalibration diff.
//   2. findRecentDays time-window correctness — including local-timezone
//      handling so UK users (BST = UTC+1 in summer) can log Friday's
//      missed workout when they remember on Saturday.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { SESSIONS, EXERCISE_POOLS, findRecentDays } from "../lib/programme.js";

// ─── Pool[0] invariant ──────────────────────────────────────────────────────
describe("EXERCISE_POOLS pool[0] === SESSIONS default", () => {
  // Build a flat map of slot key → SESSIONS default exercise.
  // Keys: blockId for non-superset (e.g. "ass2"), `${blockId}-${A|B}` otherwise.
  const sessionDefaults = {};
  for (const sess of SESSIONS) {
    for (const block of sess.blocks) {
      if (block.type === "main") continue;
      if (block.ex)  sessionDefaults[block.id] = block.ex;
      if (block.exA) sessionDefaults[`${block.id}-A`] = block.exA;
      if (block.exB) sessionDefaults[`${block.id}-B`] = block.exB;
    }
  }

  // Every pool's pool[0] must equal the SESSIONS default for that slot
  // across every field the engine reads: name, reps, weight, muscle, vid,
  // loadType. Any drift makes the rotation engine present a different
  // exercise on the first session of a new block than the home screen
  // advertises, which silently invalidates muscle-anchor lookups and
  // confuses users.
  const fields = ["name", "reps", "weight", "muscle", "vid", "loadType"];

  for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
    it(`${key} pool[0] matches SESSIONS default on every field`, () => {
      const def = sessionDefaults[key];
      expect(def, `No SESSIONS default for slot ${key}`).toBeTruthy();
      const head = slot.pool[0];
      for (const f of fields) {
        expect(head[f], `${key}.${f} mismatch`).toEqual(def[f]);
      }
    });
  }
});

// Helper: format a Date as a local-timezone YYYY-MM-DD string.
function fmtLocal(d) {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const dd   = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ─── findRecentDays — timezone correctness ──────────────────────────────────
describe("findRecentDays — local timezone handling", () => {
  it("returns the expected number of rows for daysBack=3", () => {
    const rows = findRecentDays([], 3);
    expect(rows).toHaveLength(3);
  });

  it("excludes today; the most recent row is yesterday in LOCAL time", () => {
    const rows = findRecentDays([], 3, { order: "asc" });
    expect(rows).toHaveLength(3);
    const todayLocal = fmtLocal(new Date());
    expect(rows[rows.length - 1].date).not.toBe(todayLocal); // not today

    // Yesterday — using local date arithmetic
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(rows[rows.length - 1].date).toBe(fmtLocal(yesterday));
  });

  it("BST regression: when local time is morning, retro window must NOT slip a day", () => {
    // The bug: a UK user (UTC+1 in summer) checking on Saturday morning could
    // not see Friday in the retro picker, because the old impl used
    // toISOString().slice(0,10) on a Date set to local midnight, which in BST
    // converts back to the previous day in UTC. The 3-day window then
    // surveyed Thursday/Wednesday/Tuesday instead of Friday/Thursday/Wednesday.
    //
    // This test asserts the picker's returned dates are in lockstep with the
    // user's LOCAL calendar regardless of UTC offset: rows[i].date for i=1
    // must equal "yesterday on the user's local clock," period.
    const rows = findRecentDays([], 3, { order: "asc" });
    const expected = [];
    for (let i = 3; i >= 1; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      expected.push(fmtLocal(d));
    }
    expect(rows.map(r => r.date)).toEqual(expected);
  });

  it("does not list today even with sessions logged today", () => {
    const todayStr = fmtLocal(new Date());
    const history = [{ id: `${todayStr}T10:00:00.000Z`, date: todayStr, session: "strength-a" }];
    const rows = findRecentDays(history, 3);
    expect(rows.find(r => r.date === todayStr)).toBeUndefined();
  });

  it("daysBack=0 returns empty list", () => {
    expect(findRecentDays([], 0)).toEqual([]);
  });
});
