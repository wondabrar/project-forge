import { put, list, del, get } from "@vercel/blob";
import { NextResponse } from "next/server";

// Blob layout (case-insensitive — path uses lowercase, display name lives in meta):
//   forge/profiles/{lowerName}/meta.json    — weights, reps, streak, programmeBlock, displayName
//   forge/profiles/{lowerName}/history.json — full session history (append-only)
//
// Store access: PRIVATE.
// Requires @vercel/blob@^2 (adds private-store support + get() for auth'd reads).

const normalise    = (name) => String(name || "").trim().toLowerCase();
const metaPath     = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/meta.json`;
const historyPath  = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/history.json`;
const legacyPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}`;

// Read a private blob's JSON body via the SDK's authenticated get().
// Returns null on not-found / parse error / any other failure.
async function readJson(pathname) {
  try {
    const result = await get(pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    // Consume the ReadableStream into a string
    const reader = result.stream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(buffer);
    return JSON.parse(text);
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

    const findLatest = (pathMatch) => {
      const matches = blobs.filter(b => b.pathname === pathMatch || b.pathname.startsWith(`${pathMatch}-`));
      if (!matches.length) return null;
      return matches.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    };

    const metaBlob    = findLatest(metaPath(profile));
    const historyBlob = findLatest(historyPath(profile));

    const [meta, history] = await Promise.all([
      metaBlob    ? readJson(metaBlob.pathname)    : Promise.resolve(null),
      historyBlob ? readJson(historyBlob.pathname) : Promise.resolve(null),
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

    // ── Meta write ──────────────────────────────────────────────
    if (data.meta) {
      // Clear prior meta blobs (they have random suffixes, so no natural overwrite)
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

    // ── History write (merge with remote) ───────────────────────
    if (Array.isArray(data.history)) {
      const { blobs } = await list({ prefix: historyPath(profile) });

      let existing = [];
      const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
      if (latest) {
        const pulled = await readJson(latest.pathname);
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
