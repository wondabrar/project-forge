import { NextResponse } from "next/server";
import { put, list, get } from "@vercel/blob";
import crypto from "crypto";

// Generate authentication options for WebAuthn
// POST /api/auth/login-options
// Body: { profile: string }

const normalise = (name) => String(name || "").trim().toLowerCase();
// Note: Vercel Blob addRandomSuffix inserts BEFORE extension
// So credentials.json becomes credentials-ABC123.json
const credentialsPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`;

// Read JSON from private blob using list() + get()
// Uses the same pattern as sync route - get() expects pathname, not URL
async function readJsonByPrefix(prefix) {
  try {
    const { blobs } = await list({ prefix });
    if (!blobs.length) return null;
    const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    // IMPORTANT: get() expects pathname, not url
    const result = await get(latest.pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    // Consume the ReadableStream into a string (same as sync route)
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

export async function POST(request) {
  try {
    const { profile } = await request.json();
    if (!profile) {
      return NextResponse.json({ error: "No profile" }, { status: 400 });
    }

    // Find credentials for this profile
    const credData = await readJsonByPrefix(credentialsPrefix(profile));
    
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
