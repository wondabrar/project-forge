// lib/analytics.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure aggregation helpers over session history. No React, no side effects.
// All functions return plain data ready for SVG rendering.
// Expect history in the shape produced by finaliseDraft() in storage.js.
// ─────────────────────────────────────────────────────────────────────────────

// ─── 1RM estimation (Epley formula) ───────────────────────────────────────────
// Well-established, used by most evidence-based training apps.
// Accurate for 1–10 rep range; becomes lossy above 12 reps.
export function epley1RM(weight, reps) {
  if (!weight || !reps) return null;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// ─── Main lift trend ──────────────────────────────────────────────────────────
// Returns { [exerciseName]: [{ date, est1RM, topSet:{weight,reps,rpe} }] }
// Only includes exercises logged in "main" blocks. Skips sessions marked cooked
// so trend reflects true progression, not deload weeks.
// Bodyweight exercises (weight=null) produce null est1RM → filtered out.
export function mainLiftTrend(history, { includeCooked = false } = {}) {
  const byLift = {};
  for (const rec of history || []) {
    if (!includeCooked && rec.readiness === "cooked") continue;
    const mains = (rec.blocks || []).filter(b => b.type === "main");
    for (const block of mains) {
      for (const ex of block.exercises || []) {
        // Top set = highest estimated 1RM across the sets logged
        let best = null;
        for (const s of ex.sets || []) {
          const est = epley1RM(s.weight, parseReps(s.reps));
          if (est !== null && (!best || est > best.est1RM)) {
            best = { est1RM: est, weight: s.weight, reps: s.reps, rpe: s.rpe };
          }
        }
        if (!best) continue;
        if (!byLift[ex.name]) byLift[ex.name] = [];
        byLift[ex.name].push({
          date: rec.date,
          est1RM: best.est1RM,
          topSet: { weight: best.weight, reps: best.reps, rpe: best.rpe },
          cooked: rec.readiness === "cooked",
        });
      }
    }
  }
  // Sort each lift's series chronologically
  for (const name of Object.keys(byLift)) {
    byLift[name].sort((a, b) => a.date.localeCompare(b.date));
  }
  return byLift;
}

// "8/leg" → 8, "30s" → 30 (degenerate but non-zero), bare number → itself
function parseReps(reps) {
  if (typeof reps === "number") return reps;
  if (typeof reps === "string") {
    const m = reps.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  return 0;
}

// ─── Weekly volume per muscle group ───────────────────────────────────────────
// Volume = sets × reps × weight (for weighted exercises).
// Bodyweight exercises contribute sets × reps × bodyweight-proxy (skipped for
// now — adding proxy weights is a future refinement).
// Returns [{ weekStart, byMuscle: { "Quadriceps": { sets, volume }, ... } }]
export function weeklyVolume(history) {
  const byWeek = {};
  for (const rec of history || []) {
    const weekStart = mondayOfWeek(rec.date);
    if (!byWeek[weekStart]) byWeek[weekStart] = {};
    for (const block of rec.blocks || []) {
      for (const ex of block.exercises || []) {
        const muscle = normaliseMuscle(ex.muscle);
        if (!muscle) continue;
        if (!byWeek[weekStart][muscle]) byWeek[weekStart][muscle] = { sets: 0, volume: 0 };
        for (const s of ex.sets || []) {
          byWeek[weekStart][muscle].sets += 1;
          const reps = parseReps(s.reps);
          if (s.weight && reps) {
            byWeek[weekStart][muscle].volume += s.weight * reps;
          }
        }
      }
    }
  }
  return Object.entries(byWeek)
    .map(([weekStart, byMuscle]) => ({ weekStart, byMuscle }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// Collapse granular muscle names into broader groups for rollup readability
// e.g. "Upper chest" → "Chest", "Quads & Glutes" → "Legs"
function normaliseMuscle(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes("chest") || s.includes("pec"))               return "Chest";
  if (s.includes("back") || s.includes("lat"))                return "Back";
  if (s.includes("delt") || s.includes("shoulder") || s.includes("cuff")) return "Shoulders";
  if (s.includes("quad") || s.includes("glute") || s.includes("ham") || s.includes("adductor") || s.includes("posterior chain")) return "Legs";
  if (s.includes("bicep") || s.includes("brachial"))          return "Biceps";
  if (s.includes("tricep"))                                   return "Triceps";
  if (s.includes("core") || s.includes("anti"))               return "Core";
  if (s.includes("full body"))                                return "Full body";
  return "Other";
}

// ─── Consistency grid ────────────────────────────────────────────────────────
// Returns a 7 × N grid (rows = Mon..Sun, cols = weeks, oldest left).
// Each cell = { date, trained, cooked, sessionType }.
export function consistencyGrid(history, weeks = 12) {
  const today = new Date();
  const todayMon = mondayOfWeek(today.toISOString().slice(0, 10));
  const cols = [];
  // Build N weeks of columns ending in current week
  for (let w = weeks - 1; w >= 0; w--) {
    const weekStartDate = new Date(todayMon);
    weekStartDate.setDate(weekStartDate.getDate() - w * 7);
    const weekStart = weekStartDate.toISOString().slice(0, 10);
    const col = { weekStart, days: [] };
    for (let d = 0; d < 7; d++) {
      const dayDate = new Date(weekStartDate);
      dayDate.setDate(dayDate.getDate() + d);
      const dateStr = dayDate.toISOString().slice(0, 10);
      col.days.push({ date: dateStr, trained: false, cooked: false, sessionType: null });
    }
    cols.push(col);
  }
  // Fill in training data
  for (const rec of history || []) {
    for (const col of cols) {
      const day = col.days.find(d => d.date === rec.date);
      if (day) {
        day.trained = true;
        day.cooked = rec.readiness === "cooked";
        day.sessionType = rec.session;
        break;
      }
    }
  }
  return cols;
}

// ─── Readiness breakdown ──────────────────────────────────────────────────────
// Returns { fresh, normal, cooked, total } counts across all history.
export function readinessBreakdown(history) {
  const counts = { fresh: 0, normal: 0, cooked: 0 };
  for (const rec of history || []) {
    if (counts[rec.readiness] !== undefined) counts[rec.readiness] += 1;
  }
  return { ...counts, total: counts.fresh + counts.normal + counts.cooked };
}

// ─── Session counts ───────────────────────────────────────────────────────────
export function sessionCount(history) {
  const today = Date.now();
  const sevenAgo  = today - 7  * 86400000;
  const thirtyAgo = today - 30 * 86400000;
  let total = 0, last7 = 0, last30 = 0;
  for (const rec of history || []) {
    total += 1;
    const t = new Date(rec.id).getTime();
    if (t >= sevenAgo) last7 += 1;
    if (t >= thirtyAgo) last30 += 1;
  }
  return { total, last7, last30 };
}

// ─── Plateau hint ─────────────────────────────────────────────────────────────
// Simple detector: on a given main lift, have the last N sessions held the
// same top-set weight? Returns { lift, weight, sessions } for any such lift.
// Doesn't fire unless there are at least N sessions for the lift.
export function detectPlateaus(history, { minSessions = 3 } = {}) {
  const trends = mainLiftTrend(history);
  const plateaus = [];
  for (const [lift, series] of Object.entries(trends)) {
    if (series.length < minSessions) continue;
    const recent = series.slice(-minSessions);
    const weights = recent.map(p => p.topSet.weight);
    const allEqual = weights.every(w => w === weights[0]);
    if (allEqual && weights[0]) {
      plateaus.push({ lift, weight: weights[0], sessions: minSessions });
    }
  }
  return plateaus;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function mondayOfWeek(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d);
  mon.setDate(diff);
  return mon.toISOString().slice(0, 10);
}
