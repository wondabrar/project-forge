import { NextResponse } from "next/server";
import { list, get } from "@vercel/blob";

// Check if a profile has passkeys registered
// GET /api/auth/check?profile=Name

const normalise = (name) => String(name || "").trim().toLowerCase();
const credentialsPath = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials.json`;

async function readJson(pathname) {
  try {
    const result = await get(pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
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
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return null;
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const profile = searchParams.get("profile");
    
    if (!profile) {
      return NextResponse.json({ error: "No profile" }, { status: 400 });
    }

    const { blobs } = await list({ prefix: credentialsPath(profile) });
    if (!blobs.length) {
      return NextResponse.json({ hasPasskey: false });
    }

    const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    const credData = await readJson(latest.pathname);
    
    return NextResponse.json({
      hasPasskey: credData?.credentials?.length > 0,
      credentialCount: credData?.credentials?.length || 0,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
