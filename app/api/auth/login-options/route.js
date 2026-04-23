import { NextResponse } from "next/server";
import { put, list } from "@vercel/blob";
import crypto from "crypto";

// Generate authentication options for WebAuthn
// POST /api/auth/login-options
// Body: { profile: string }

const normalise = (name) => String(name || "").trim().toLowerCase();
const credentialsPath = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials.json`;

// Read JSON from blob using list() + fetch (handles addRandomSuffix paths)
async function readJsonByPrefix(prefix) {
  try {
    const { blobs } = await list({ prefix });
    if (!blobs.length) return null;
    const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    const res = await fetch(latest.url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
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
    const { blobs } = await list({ prefix: credentialsPath(profile) });
    if (!blobs.length) {
      return NextResponse.json(
        { error: "No passkey registered for this profile" },
        { status: 404 }
      );
    }

    const credData = await readJsonByPrefix(credentialsPath(profile));
    
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
