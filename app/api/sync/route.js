import { put, list, del } from "@vercel/blob";
import { NextResponse } from "next/server";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Blob layout (case-insensitive — path uses lowercase, display name lives in meta):
//   forge/profiles/{lowerName}/meta.json    — weights, reps, streak, programmeBlock, displayName
//   forge/profiles/{lowerName}/history.json — full session history (append-only)

const normalise   = (name) => String(name || "").trim().toLowerCase();
const metaPath    = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/meta.json`;
const historyPath = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/history.json`;
const legacyPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}`;

// OPTIONS preflight for CORS
export async function OPTIONS() {
  return NextResponse.json(null, { headers: corsHeaders });
}

// GET /api/sync?profile=Name
// Returns { meta: {...}, history: [...] }
//
// GET /api/sync?profile=Name&check=1
// Returns { exists: boolean } — lightweight availability check for signup.
// Case-insensitive: "Sarah", "sarah", "SARAH" all resolve the same way.
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const profile = searchParams.get("profile");
  const check   = searchParams.get("check") === "1";
  if (!profile) return NextResponse.json(null, { status: 400, headers: corsHeaders });

  try {
    const { blobs } = await list({ prefix: legacyPrefix(profile) });

    if (check) {
      return NextResponse.json({ exists: blobs.length > 0 }, { headers: corsHeaders });
    }

    if (!blobs.length) return NextResponse.json(null, { status: 404, headers: corsHeaders });

    const findLatest = (pathMatch) => {
      const matches = blobs.filter(b => b.pathname === pathMatch || b.pathname.startsWith(`${pathMatch}-`));
      if (!matches.length) return null;
      return matches.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    };

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

    return NextResponse.json({ meta, history: history || [] }, { headers: corsHeaders });
  } catch (e) {
    return NextResponse.json(null, { status: 500, headers: corsHeaders });
  }
}

// PUT /api/sync
// Body: { profile: string, data: { meta?: object, history?: array } }
// Profile is case-insensitive. Display name should be passed inside meta.displayName.
export async function PUT(request) {
  try {
    const { profile, data } = await request.json();
    if (!profile) return NextResponse.json({ error: "No profile" }, { status: 400, headers: corsHeaders });
    if (!data)    return NextResponse.json({ error: "No data"    }, { status: 400, headers: corsHeaders });

    const results = {};

    if (data.meta) {
      const { blobs } = await list({ prefix: legacyPrefix(profile) });
      const obsolete = blobs.filter(b =>
        b.pathname === `forge/profiles/${encodeURIComponent(normalise(profile))}.json` ||
        b.pathname.startsWith(`forge/profiles/${encodeURIComponent(normalise(profile))}.json`) ||
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

    if (Array.isArray(data.history)) {
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

    return NextResponse.json({ ok: true, ...results }, { headers: corsHeaders });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}

// POST /api/sync — name claim endpoint.
// Reserves a name with a minimal meta blob so subsequent existence checks resolve.
// Called immediately on profile creation so concurrent devices see the claim.
// Body: { profile: string, displayName: string }
// Returns 409 if the name is already taken.
export async function POST(request) {
  try {
    const { profile, displayName } = await request.json();
    if (!profile) return NextResponse.json({ error: "No profile" }, { status: 400, headers: corsHeaders });

    const { blobs } = await list({ prefix: legacyPrefix(profile) });
    if (blobs.length > 0) {
      return NextResponse.json({ error: "Name taken", exists: true }, { status: 409, headers: corsHeaders });
    }

    await put(
      metaPath(profile),
      JSON.stringify({
        displayName: displayName || profile,
        claimedAt: new Date().toISOString(),
        weights: {},
        reps: {},
        streak: { count: 0, lastDate: null },
      }),
      { access: "public", contentType: "application/json", addRandomSuffix: true }
    );

    return NextResponse.json({ ok: true, claimed: true }, { headers: corsHeaders });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}
