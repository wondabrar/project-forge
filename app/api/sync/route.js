import { put, list, del } from "@vercel/blob";
import { NextResponse } from "next/server";

// Blob layout (case-insensitive — path uses lowercase, display name lives in meta):
//   forge/profiles/{lowerName}/meta.json    — weights, reps, streak, programmeBlock, displayName
//   forge/profiles/{lowerName}/history.json — full session history (append-only)
//
// Store access: PRIVATE.
// Writes use put({ access:"private" }) — the SDK handles auth via BLOB_READ_WRITE_TOKEN.
// Reads fetch blob.url directly with a Bearer token header, per Vercel docs:
//   https://vercel.com/docs/vercel-blob/private-storage

const normalise    = (name) => String(name || "").trim().toLowerCase();
const metaPath     = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/meta.json`;
const historyPath  = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/history.json`;
const legacyPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}`;

// Read a private blob's JSON body using the read-write token.
async function readJson(blobUrl) {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return null;
    const res = await fetch(blobUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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
  if (!profile) return NextResponse.json(null, { status: 400 });

  try {
    const { blobs } = await list({ prefix: legacyPrefix(profile) });

    if (check) {
      return NextResponse.json({ exists: blobs.length > 0 });
    }

    if (!blobs.length) return NextResponse.json(null, { status: 404 });

    // Find latest canonical blob for each path (stable path + random suffix pattern)
    const findLatest = (pathMatch) => {
      const matches = blobs.filter(b => b.pathname === pathMatch || b.pathname.startsWith(`${pathMatch}-`));
      if (!matches.length) return null;
      return matches.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    };

    const metaBlob    = findLatest(metaPath(profile));
    const historyBlob = findLatest(historyPath(profile));

    const [meta, history] = await Promise.all([
      metaBlob    ? readJson(metaBlob.url)    : Promise.resolve(null),
      historyBlob ? readJson(historyBlob.url) : Promise.resolve(null),
    ]);

    return NextResponse.json({ meta, history: Array.isArray(history) ? history : [] });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PUT /api/sync
// Body: { profile: string, data: { meta?: object, history?: array } }
// Profile is case-insensitive. Display name should be passed inside meta.displayName.
export async function PUT(request) {
  try {
    const { profile, data } = await request.json();
    if (!profile) return NextResponse.json({ error: "No profile" }, { status: 400 });
    if (!data)    return NextResponse.json({ error: "No data"    }, { status: 400 });

    const results = {};

    if (data.meta) {
      const { blobs } = await list({ prefix: legacyPrefix(profile) });
      const obsolete = blobs.filter(b =>
        b.pathname === metaPath(profile) ||
        b.pathname.startsWith(`${metaPath(profile)}-`)
      );
      if (obsolete.length) {
        try { await del(obsolete.map(b => b.url)); } catch {}
      }
      await put(
        metaPath(profile),
        JSON.stringify({ ...data.meta, syncedAt: new Date().toISOString() }),
        { access: "private", contentType: "application/json", addRandomSuffix: true }
      );
      results.meta = true;
    }

    if (Array.isArray(data.history)) {
      const { blobs } = await list({ prefix: historyPath(profile) });

      // Pull existing history to merge with incoming
      let existing = [];
      const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
      if (latest) {
        const pulled = await readJson(latest.url);
        if (Array.isArray(pulled)) existing = pulled;
      }

      const byId = new Map();
      [...existing, ...data.history].forEach(rec => {
        if (rec && rec.id) byId.set(rec.id, rec);
      });
      const merged = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));

      if (blobs.length) {
        try { await del(blobs.map(b => b.url)); } catch {}
      }
      await put(
        historyPath(profile),
        JSON.stringify(merged),
        { access: "private", contentType: "application/json", addRandomSuffix: true }
      );
      results.history = { count: merged.length };
    }

    return NextResponse.json({ ok: true, ...results });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
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
    if (!profile) return NextResponse.json({ error: "No profile" }, { status: 400 });

    const { blobs } = await list({ prefix: legacyPrefix(profile) });
    if (blobs.length > 0) {
      return NextResponse.json({ error: "Name taken", exists: true }, { status: 409 });
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
      { access: "private", contentType: "application/json", addRandomSuffix: true }
    );

    return NextResponse.json({ ok: true, claimed: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
