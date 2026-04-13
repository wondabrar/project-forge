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
  list:        ()      => LS.get("forge:profiles", []),
  add:         (n)     => { const p = P.list(); if (!p.includes(n)) LS.set("forge:profiles", [...p, n]); },
  getActive:   ()      => LS.get("forge:active", null),
  setActive:   (n)     => LS.set("forge:active", n),
  getWeights:  (n)     => LS.get(`forge:${n}:weights`, {}),
  saveWeights: (n, w)  => LS.set(`forge:${n}:weights`, w),
  getReps:     (n)     => LS.get(`forge:${n}:reps`, {}),
  saveReps:    (n, r)  => LS.set(`forge:${n}:reps`, r),
  getStreak:   (n)     => LS.get(`forge:${n}:streak`, { count: 0, lastDate: null }),
  saveStreak:  (n, s)  => LS.set(`forge:${n}:streak`, s),
};

export function bumpStreak(name) {
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const { count, lastDate } = P.getStreak(name);
  if (lastDate === today) return count;
  const next = lastDate === yesterday ? count + 1 : 1;
  P.saveStreak(name, { count: next, lastDate: today });
  return next;
}

// ─── Programme block (rotation state) ────────────────────────────────────────
// Shared across profiles — one training block for the whole device.
// Synced to Vercel Blob so it survives device switches.
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
// Fire-and-forget — localStorage is always source of truth.
// Blob acts as a cross-device backup. Never blocks the UI.

export async function blobPull(profile) {
  try {
    const res = await fetch(`/api/sync?profile=${encodeURIComponent(profile)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function blobPush(profile, data) {
  try {
    await fetch("/api/sync", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, data }),
    });
  } catch { /* silent */ }
}

// ─── Progression utilities ────────────────────────────────────────────────────
// Pure functions — no side effects.

// Round to nearest 1.25 kg plate increment
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
