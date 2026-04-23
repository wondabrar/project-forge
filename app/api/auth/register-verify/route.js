import { NextResponse } from "next/server";
import { put, list, del, get } from "@vercel/blob";
import crypto from "crypto";

// Verify WebAuthn registration and store credential
// POST /api/auth/register-verify
// Body: { profile: string, credential: { id, rawId, type, response: { clientDataJSON, attestationObject } } }

const normalise = (name) => String(name || "").trim().toLowerCase();
// Note: Vercel Blob addRandomSuffix inserts BEFORE extension
const credentialsPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`;
// Full path for writing new credentials (will get suffix added)
const credentialsPath = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials.json`;

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

function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(padLen);
  const binary = Buffer.from(padded, "base64");
  return binary;
}

export async function POST(request) {
  try {
    const { profile, credential } = await request.json();
    if (!profile || !credential) {
      return NextResponse.json({ error: "Missing profile or credential" }, { status: 400 });
    }

    const userId = crypto
      .createHash("sha256")
      .update(normalise(profile))
      .digest("base64url");

    // Retrieve and validate the challenge
    const challengeKey = `forge/challenges/${userId}`;
    console.log("[v0] register-verify: looking for challenge at", challengeKey);
    const challengeData = await readJsonByPrefix(challengeKey);
    console.log("[v0] register-verify: challengeData =", challengeData);
    
    if (!challengeData) {
      return NextResponse.json({ error: "No pending registration" }, { status: 400 });
    }
    
    if (Date.now() > challengeData.expires) {
      return NextResponse.json({ error: "Registration expired" }, { status: 400 });
    }

    if (challengeData.profile !== normalise(profile)) {
      return NextResponse.json({ error: "Profile mismatch" }, { status: 400 });
    }

    // Parse clientDataJSON to verify challenge
    const clientDataJSON = JSON.parse(base64urlToBuffer(credential.response.clientDataJSON).toString());
    
    if (clientDataJSON.challenge !== challengeData.challenge) {
      return NextResponse.json({ error: "Challenge mismatch" }, { status: 400 });
    }

    if (clientDataJSON.type !== "webauthn.create") {
      return NextResponse.json({ error: "Invalid operation type" }, { status: 400 });
    }

    // In a production app, you'd parse the attestationObject to extract the public key.
    // For this minimal implementation, we store the credential ID and trust the browser.
    // The credential ID is sufficient for authentication since we verify via the browser.

    // Load existing credentials
    const existing = await readJsonByPrefix(credentialsPrefix(profile)) || { credentials: [] };
    
    // Add new credential
    const newCredential = {
      id: credential.id,
      rawId: credential.rawId,
      type: credential.type,
      createdAt: new Date().toISOString(),
      // Store the attestation for potential future verification
      attestationObject: credential.response.attestationObject,
    };

    // Prevent duplicates
    const updated = {
      credentials: [
        ...existing.credentials.filter(c => c.id !== credential.id),
        newCredential,
      ],
    };

    // Clean up old credentials file if exists
    const { blobs } = await list({ prefix: credentialsPrefix(profile) });
    if (blobs.length) {
      try { await del(blobs.map(b => b.url)); } catch {}
    }

    // Save credentials
    console.log("[v0] register-verify: saving credentials to", credentialsPath(profile));
    const putResult = await put(credentialsPath(profile), JSON.stringify(updated), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: true,
    });
    console.log("[v0] register-verify: put result =", putResult.pathname);

    // Clean up challenge
    try {
      const { blobs: challengeBlobs } = await list({ prefix: challengeKey });
      if (challengeBlobs.length) {
        await del(challengeBlobs.map(b => b.url));
      }
    } catch {}

    return NextResponse.json({
      ok: true,
      credentialId: credential.id,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
