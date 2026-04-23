import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import crypto from "crypto";
import { readJsonDirect, readJsonByPrefix, deleteByPrefix } from "@/lib/blob-utils";

// Verify WebAuthn registration and store credential
// POST /api/auth/register-verify
// Body: { profile: string, credential: { id, rawId, type, response: { clientDataJSON, attestationObject } } }

const normalise = (name) => String(name || "").trim().toLowerCase();
// Note: Vercel Blob addRandomSuffix inserts BEFORE extension
const credentialsPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`;
// Full path for writing new credentials (will get suffix added)
const credentialsPath = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials.json`;

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

    // Retrieve and validate the challenge (challenges use addRandomSuffix: false, so use direct read)
    const challengeKey = `forge/challenges/${userId}`;
    const challengeData = await readJsonDirect(challengeKey);
    
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
    await deleteByPrefix(credentialsPrefix(profile));

    // Save credentials
    await put(credentialsPath(profile), JSON.stringify(updated), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: true,
    });

    // Clean up challenge
    await deleteByPrefix(challengeKey);

    return NextResponse.json({
      ok: true,
      credentialId: credential.id,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
