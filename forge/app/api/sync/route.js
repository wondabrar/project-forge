import { put, list, del } from "@vercel/blob";
import { NextResponse } from "next/server";

// GET /api/sync?profile=Name  — fetch profile data from blob
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const profile = searchParams.get("profile");
  if (!profile) return NextResponse.json(null, { status: 400 });

  try {
    const prefix = `forge/profiles/${encodeURIComponent(profile)}`;
    const { blobs } = await list({ prefix });
    if (!blobs.length) return NextResponse.json(null, { status: 404 });

    // Most recent blob for this profile
    const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    const res = await fetch(latest.url);
    if (!res.ok) return NextResponse.json(null, { status: 404 });

    const data = await res.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(null, { status: 500 });
  }
}

// PUT /api/sync  body: { profile: string, data: object }
export async function PUT(request) {
  try {
    const { profile, data } = await request.json();
    if (!profile) return NextResponse.json({ error: "No profile" }, { status: 400 });

    const pathname = `forge/profiles/${encodeURIComponent(profile)}.json`;

    // Remove old blobs for this profile to avoid accumulation
    const { blobs } = await list({ prefix: `forge/profiles/${encodeURIComponent(profile)}` });
    if (blobs.length > 0) {
      await del(blobs.map((b) => b.url));
    }

    await put(pathname, JSON.stringify({ ...data, syncedAt: new Date().toISOString() }), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: true,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
