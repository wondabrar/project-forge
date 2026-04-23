import { NextResponse } from "next/server";
import { list } from "@vercel/blob";

// Check if a profile has passkeys registered
// GET /api/auth/check?profile=Name
//
// Uses list() with prefix to find credentials blobs (they have random suffixes).
// If any blob exists at the credentials path prefix, the profile has passkeys.

const normalise = (name) => String(name || "").trim().toLowerCase();
// Note: Vercel Blob addRandomSuffix inserts BEFORE extension
// So credentials.json becomes credentials-ABC123.json, NOT credentials.json-ABC123
// Search for prefix WITHOUT extension to match correctly
const credentialsPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`;

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const profile = searchParams.get("profile");
    
    if (!profile) {
      return NextResponse.json({ error: "No profile" }, { status: 400 });
    }

    // List blobs with the credentials prefix (matches credentials-*.json)
    const { blobs } = await list({ prefix: credentialsPrefix(profile) });
    
    // If any credentials blob exists, the profile has passkeys
    return NextResponse.json({
      hasPasskey: blobs.length > 0,
      credentialCount: blobs.length > 0 ? 1 : 0,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
