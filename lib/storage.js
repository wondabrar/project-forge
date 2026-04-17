// lib/storage.js
// ─────────────────────────────────────────────────────────────────────────────
// localStorage helpers, Vercel Blob sync, and stateless progression utilities.
// No React, no JSX. Safe to import in both client components and API routes.
// ─────────────────────────────────────────────────────────────────────────────

// ─── localStorage (SSR-safe) ──────────────────────────────────────────────────
export const LS = {
  get: (key, fallback = null) => {
    if (typeof window === "undefined") return fallback;
    try {
      const v = localStorage.getItem(key);
      return v !== null ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  set: (key, val) => {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  },
};

// ─── Per-profile data ─────────────────────────────────────────────────────────
export const P = {
  list:         ()       => LS.get("forge:profiles", []),
  add:          (n)      => { const p = P.list(); if (!p.includes(n)) LS.set("forge:profiles", [...p, n]); },
  getActive:    ()       => LS.get("forge:active", null),
  setActive:    (n)      => LS.set("forge:active", n),
  getWeights:   (n)      => LS.get(`forge:${n}:weights`, {}),
  saveWeights:  (n, w)   => LS.set(`forge:${n}:weights`, w),
  getReps:      (n)      => LS.get(`forge:${n}:reps`, {}),
  saveReps:     (n, r)   => LS.set(`forge:${n}:reps`, r),
  getStreak:    (n)      => LS.get(`forge:${n}:streak`, { count: 0, lastDate: null }),
  saveStreak:   (n, s)   => LS.set(`forge:${n}:streak`, s),
  getWeekDone:  (n)      => LS.get(`forge:${n}:weekDone:${weekKey()}`, {}),
  saveWeekDone: (n, d)   => LS.set(`forge:${n}:weekDone:${weekKey()}`, d),
  markDayDone:  (n, idx) => {
    const d = P.getWeekDone(n);
    const next = { ...d, [idx]: true };
    P.saveWeekDone(n, next);
    return next;
  },
};

// ─── Rhythm (formerly "streak") ──────────────────────────────────────────────
// Replaces the classic "consecutive days" streak with a rolling 28-day
// adherence ratio. The expected sessions in a 28-day window is 12 (3 strength
// days × 4 weeks). Missing a single day or even a whole week doesn't "break"
// anything — the number drops gracefully and recovers as you train again.
//
// Returns: { completed: int, expected: 12, ratio: float, window: 28 }
const RHYTHM_WINDOW_DAYS = 28;
const RHYTHM_EXPECTED    = 12; // 3 strength sessions/week × 4 weeks

export function computeRhythm(history) {
  const now = Date.now();
  const since = now - RHYTHM_WINDOW_DAYS * 86400000;
  const completed = (Array.isArray(history) ? history : [])
    .filter(rec => rec && rec.session && rec.session.startsWith("strength"))
    .filter(rec => {
      const t = new Date(rec.id).getTime();
      return !isNaN(t) && t >= since && t <= now;
    }).length;
  return {
    completed,
    expected: RHYTHM_EXPECTED,
    ratio: Math.min(1, completed / RHYTHM_EXPECTED),
    window: RHYTHM_WINDOW_DAYS,
  };
}

// Legacy helper — kept so existing callers don't break during transition.
// After this patch, HomeScreen should read rhythm directly from history.
export function bumpStreak(name) {
  const today = new Date().toISOString().slice(0, 10);
  const { lastDate } = P.getStreak(name);
  if (lastDate === today) return P.getStreak(name).count;
  // We no longer store a "count" — rhythm is derived from history at render time.
  // But we keep lastDate so we can detect "trained today" without history access.
  P.saveStreak(name, { count: 0, lastDate: today });
  return 0;
}

// ─── Pattern detection — surfaces gentle observations ────────────────────────
// Returns { kind, message } or null. Never nags — caller decides whether to
// render, and the UI should respect a dismissed-in-this-session flag.
export function detectRecoveryPattern(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  // Look at the last 2 sessions in the last 14 days. If both cooked, nudge.
  const fourteenDaysAgo = Date.now() - 14 * 86400000;
  const recent = history
    .filter(rec => rec && rec.id && rec.session && rec.session.startsWith("strength"))
    .filter(rec => new Date(rec.id).getTime() >= fourteenDaysAgo)
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 2);
  if (recent.length < 2) return null;
  const bothCooked = recent.every(r => r.readiness === "cooked");
  if (bothCooked) {
    return {
      kind: "recovery",
      message: "Two cooked sessions in a row. Often that's recovery, sleep, or stress — not effort. Rest is a training variable too.",
    };
  }
  return null;
}

// ─── History (append-only session log) ────────────────────────────────────────
// Records are immutable. Primary key is ISO timestamp id.
// localStorage is a write-through cache; blob is canonical.
export const H = {
  get: (name) => LS.get(`forge:${name}:history`, []),
  save: (name, arr) => LS.set(`forge:${name}:history`, arr),
  append: (name, record) => {
    const arr = H.get(name);
    // Dedupe by id — idempotent append
    if (arr.some(r => r.id === record.id)) return arr;
    const next = [...arr, record].sort((a, b) => a.id.localeCompare(b.id));
    H.save(name, next);
    return next;
  },
  // Merge remote history into local. Dedupe by id. Sort chronologically.
  merge: (local, remote) => {
    const byId = new Map();
    [...(local || []), ...(remote || [])].forEach(r => {
      if (r && r.id) byId.set(r.id, r);
    });
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  },
};

// Pending push queue — survives reloads so failed writes retry on next open
export const PQ = {
  get: () => LS.get("forge:pendingPushes", []),
  save: (arr) => LS.set("forge:pendingPushes", arr),
  add: (profile) => {
    const pending = PQ.get();
    if (!pending.includes(profile)) PQ.save([...pending, profile]);
  },
  clear: (profile) => PQ.save(PQ.get().filter(p => p !== profile)),
};

// ─── Programme block (rotation state) ────────────────────────────────────────
// Shared across profiles on this device — one training block.
// Synced to blob so it survives device switches.
export const PB = {
  get: () => LS.get("forge:programmeBlock", {
    number:    1,
    startDate: new Date().toISOString().slice(0, 10),
    config:    {},   // current rotation; empty = use SESSIONS defaults (pool[0])
    history:   {},   // previous block's selections for exclusion on next rotate
  }),
  save: (pb) => LS.set("forge:programmeBlock", pb),
};

// ─── Vercel Blob sync ────────────────────────────────────────────────────────
// Two blob shapes per profile:
//   forge/profiles/{name}/meta.json    — weights, reps, streak, programmeBlock
//   forge/profiles/{name}/history.json — full session history (append-only)
// History is canonical in blob. Meta is "last write wins" safe.

export async function blobPull(profile) {
  try {
    const res = await fetch(`/api/sync?profile=${encodeURIComponent(profile)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function blobPush(profile, data) {
  try {
    const res = await fetch("/api/sync", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, data }),
    });
    if (!res.ok) throw new Error(`Push failed: ${res.status}`);
    PQ.clear(profile);
    return true;
  } catch {
    PQ.add(profile);
    return false;
  }
}

// Check whether a profile name is already claimed globally.
// Returns { exists: boolean } or null on network error.
export async function checkProfileExists(profile) {
  try {
    const res = await fetch(`/api/sync?profile=${encodeURIComponent(profile)}&check=1`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Claim a profile name globally. Returns { ok, taken } — taken=true if race loss.
export async function claimProfile(profile, displayName) {
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, displayName }),
    });
    if (res.status === 409) return { ok: false, taken: true };
    if (!res.ok) return { ok: false, taken: false };
    return { ok: true, taken: false };
  } catch {
    return { ok: false, taken: false };
  }
}

// Nuke all cloud data for a profile. Releases the name.
// Returns { ok, deleted } on success, { ok: false, error } on failure.
export async function blobDelete(profile) {
  try {
    const res = await fetch(`/api/sync?profile=${encodeURIComponent(profile)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    const body = await res.json();
    return { ok: true, deleted: body.deleted || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Called on app open — retry any profiles whose last push failed
export async function flushPendingPushes(dataFn) {
  const pending = PQ.get();
  if (!pending.length) return;
  for (const profile of pending) {
    const data = dataFn(profile);
    if (data) await blobPush(profile, data);
  }
}

// ─── Progression utilities ────────────────────────────────────────────────────
export const roundPlate = (kg) => Math.round(kg / 1.25) * 1.25;

// Apply an RPE rating to a working weight
export function applyRpe(weight, rpe) {
  if (weight === null || weight === undefined) return weight;
  if (rpe === "easy")  return roundPlate(weight * 1.025);
  if (rpe === "limit") return roundPlate(weight * 0.95);
  return weight; // "hard" — hold weight, don't adjust
}

// ─── Time utilities ───────────────────────────────────────────────────────────
export function weeksSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (7 * 86400000));
}

export function weekKey() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d);
  mon.setDate(diff);
  return mon.toISOString().slice(0, 10);
}

// ─── Session record builder ────────────────────────────────────────────────────
// Collects per-set logs during a session, finalises into a history record.
export function newDraftLog({ profileName, session, blockNumber, readiness, readinessReason = null }) {
  return {
    id: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    dow: new Date().getDay(),
    profileName,
    session,                 // "strength-a" | "strength-b" | "strength-c"
    blockNumber,
    readiness,               // "fresh" | "normal" | "cooked"
    readinessReason,         // "slept_well" | "slept_badly" | "stressed" | "recovering" | "just_fresh" | null
    startedAt: Date.now(),
    duration: 0,
    blocks: {},              // keyed by block.id during collection, array at finalise
  };
}

// Push a set into the draft. Creates block + exercise entries lazily.
export function logSet(draft, { blockId, blockType, exerciseName, muscle, swapped, fromPool, weight, reps, rpe }) {
  if (!draft.blocks[blockId]) {
    draft.blocks[blockId] = { id: blockId, type: blockType, exercises: {} };
  }
  const bl = draft.blocks[blockId];
  if (!bl.exercises[exerciseName]) {
    bl.exercises[exerciseName] = {
      name: exerciseName, muscle, swapped: !!swapped, fromPool: fromPool || null, sets: [],
    };
  }
  bl.exercises[exerciseName].sets.push({ weight: weight ?? null, reps, rpe: rpe || null });
  return draft;
}

// Convert nested collection into serialisable array shape
export function finaliseDraft(draft) {
  const duration = Math.round((Date.now() - draft.startedAt) / 1000);
  const blocks = Object.values(draft.blocks).map(b => ({
    id: b.id,
    type: b.type,
    exercises: Object.values(b.exercises),
  }));
  const { startedAt, ...rest } = draft;
  return { ...rest, duration, blocks };
}

// ─── Cooked-day volume scaling ─────────────────────────────────────────────────
// Returns a session with blocks modified for "cooked" readiness.
// Pure function — doesn't touch originals.
export function scaleForReadiness(session, readiness) {
  if (readiness !== "cooked") return session;
  const scaled = {
    ...session,
    blocks: session.blocks
      // Drop finishers entirely on cooked days
      .filter(b => b.type !== "finisher")
      .map(b => {
        if (b.type === "main") {
          // Scale main lift weight to 85% — deload level
          const scaleEx = (ex) => ex?.weight ? { ...ex, weight: roundPlate(ex.weight * 0.85) } : ex;
          return {
            ...b,
            ex:  scaleEx(b.ex),
            exA: scaleEx(b.exA),
            exB: scaleEx(b.exB),
          };
        }
        if (b.type === "superset") {
          // Drop the last set on supersets
          return { ...b, sets: Math.max(2, b.sets - 1) };
        }
        return b;
      }),
  };
  return scaled;
}
