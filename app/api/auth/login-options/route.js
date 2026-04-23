import { NextResponse } from "next/server";
import { put, list, head } from "@vercel/blob";
import crypto from "crypto";

// Generate authentication options for WebAuthn
// POST /api/auth/login-options
// Body: { profile: string }

const normalise = (name) => String(name || "").trim().toLowerCase();
// Note: Vercel Blob addRandomSuffix inserts BEFORE extension
// So credentials.json becomes credentials-ABC123.json
const credentialsPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`;

// Read JSON from blob using list() + head() for private blob access
async function readJsonByPrefix(prefix) {
  try {
    console.log("[v0] readJsonByPrefix v2 - prefix:", prefix);
    const { blobs } = await list({ prefix });
    console.log("[v0] Found blobs:", blobs.length, blobs.map(b => b.pathname));
    if (!blobs.length) return null;
    const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    console.log("[v0] Calling head() on:", latest.url);
    // Use head() to get downloadUrl which includes auth token for private blobs
    const headResult = await head(latest.url);
    console.log("[v0] head() result downloadUrl:", headResult.downloadUrl?.slice(0, 100));
    const res = await fetch(headResult.downloadUrl);
    console.log("[v0] Fetch response:", res.status, res.ok);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.log("[v0] readJsonByPrefix error:", e.message);
    return null;
  }
}

export async function POST(request) {
  try {
    const { profile } = await request.json();
    if (!profile) {
      return NextResponse.json({ error: "No profile" }, { status: 400 });
    }

    // Find credentials for this profile
    const prefix = credentialsPrefix(profile);
    console.log("[v0] login-options for profile:", profile, "prefix:", prefix);
    const credData = await readJsonByPrefix(prefix);
    
    if (!credData?.credentials?.length) {
      return NextResponse.json(
        { error: "No passkey registered for this profile" },
        { status: 404 }
      );
    }

    // Generate a random challenge
    const challenge = crypto.randomBytes(32).toString("base64url");

    // Generate user ID
    const userId = crypto
      .createHash("sha256")
      .update(normalise(profile))
      .digest("base64url");

    // Store challenge for verification
    const challengeKey = `forge/challenges/${userId}`;
    await put(challengeKey, JSON.stringify({ 
      challenge, 
      profile: normalise(profile), 
      expires: Date.now() + 120000,
      type: "login",
    }), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    // Get the origin for RP ID
    const origin = request.headers.get("origin") || request.headers.get("host");
    const rpId = origin?.replace(/^https?:\/\//, "").split(":")[0] || "localhost";

    return NextResponse.json({
      challenge,
      rpId,
      timeout: 60000,
      allowCredentials: credData.credentials.map(cred => ({
        id: cred.rawId,
        type: "public-key",
        transports: ["internal", "hybrid"],
      })),
      userVerification: "required",
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
