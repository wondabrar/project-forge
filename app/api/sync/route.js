import { put, list, del } from "@vercel/blob";
import { NextResponse } from "next/server";

// Blob layout (stable paths — no random suffixes for canonical records):
//   forge/profiles/{name}/meta.json    — weights, reps, streak, programmeBlock
//   forge/profiles/{name}/history.json — full session history (append-only)
//
// Legacy path:
//   forge/profiles/{name}.json  (with random suffix) — migrated on first GET

const metaPath    = (name) => `forge/profiles/${encodeURIComponent(name)}/meta.json`;
const historyPath = (name) => `forge/profiles/${encodeURIComponent(name)}/history.json`;
const legacyPrefix = (name) => `forge/profiles/${encodeURIComponent(name)}`;

// GET /api/sync?profile=Name
// Returns { meta: {...}, history: [...] }
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const profile = searchParams.get("profile");
  if (!profile) return NextResponse.json(null, { status: 400 });

  try {
    const { blobs } = await list({ prefix: legacyPrefix(profile) });
    if (!blobs.length) return NextResponse.json(null, { status: 404 });

    // Find latest canonical blobs for meta + history
    const findLatest = (pathMatch) => {
      const matches = blobs.filter(b => b.pathname === pathMatch || b.pathname.startsWith(`${pathMatch}-`));
      if (!matches.length) return null;
      return matches.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    };

    // Prefer stable paths; fall back to any older blob for this profile for migration
    const metaBlob    = findLatest(metaPath(profile))
                     || blobs.filter(b => !b.pathname.includes("/history"))
                             .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0]
                     || null;
    const historyBlob = findLatest(historyPath(profile));

    const fetchJson = async (b) => {
      if (!b) return null;
      try {
        const r = await fetch(b.url);
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    };

    const [meta, history] = await Promise.all([
      fetchJson(metaBlob),
      fetchJson(historyBlob),
    ]);

    return NextResponse.json({ meta, history: history || [] });
  } catch (e) {
    return NextResponse.json(null, { status: 500 });
  }
}

// PUT /api/sync
// Body: { profile: string, data: { meta?: object, history?: array } }
// Writes whichever keys are present. History merged with remote by id.
export async function PUT(request) {
  try {
    const { profile, data } = await request.json();
    if (!profile) return NextResponse.json({ error: "No profile" }, { status: 400 });
    if (!data) return NextResponse.json({ error: "No data" }, { status: 400 });

    const results = {};

    // ── Meta write ────────────────────────────────────────────────────────
    if (data.meta) {
      // Remove any prior meta blobs for this profile to avoid accumulation
      // (random suffixes from legacy writes + any prior stable-path writes)
      const { blobs } = await list({ prefix: legacyPrefix(profile) });
      const obsolete = blobs.filter(b =>
        b.pathname === `forge/profiles/${encodeURIComponent(profile)}.json` ||  // legacy
        b.pathname.startsWith(`forge/profiles/${encodeURIComponent(profile)}.json`) ||
        b.pathname === metaPath(profile) ||
        b.pathname.startsWith(`${metaPath(profile)}-`)
      );
      if (obsolete.length) {
        try { await del(obsolete.map(b => b.url)); } catch {}
      }
      await put(
        metaPath(profile),
        JSON.stringify({ ...data.meta, syncedAt: new Date().toISOString() }),
        { access: "public", contentType: "application/json", addRandomSuffix: true }
      );
      results.meta = true;
    }

    // ── History write (merge with existing) ──────────────────────────────
    if (Array.isArray(data.history)) {
      // Pull existing history and merge by id
      const { blobs } = await list({ prefix: historyPath(profile) });
      let existing = [];
      const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
      if (latest) {
        try {
          const r = await fetch(latest.url);
          if (r.ok) existing = await r.json();
        } catch {}
      }
      const byId = new Map();
      [...(Array.isArray(existing) ? existing : []), ...data.history].forEach(rec => {
        if (rec && rec.id) byId.set(rec.id, rec);
      });
      const merged = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));

      // Delete prior history blobs for this profile
      if (blobs.length) {
        try { await del(blobs.map(b => b.url)); } catch {}
      }
      await put(
        historyPath(profile),
        JSON.stringify(merged),
        { access: "public", contentType: "application/json", addRandomSuffix: true }
      );
      results.history = { count: merged.length };
    }

    return NextResponse.json({ ok: true, ...results });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
