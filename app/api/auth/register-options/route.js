import { NextResponse } from "next/server";
import { list } from "@vercel/blob";
import crypto from "crypto";

// Generate registration options for WebAuthn
// POST /api/auth/register-options
// Body: { profile: string }

const normalise = (name) => String(name || "").trim().toLowerCase();
const legacyPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/`;

export async function POST(request) {
  try {
    const { profile } = await request.json();
    if (!profile) {
      return NextResponse.json({ error: "No profile" }, { status: 400 });
    }

    // Check if profile exists (must exist to register a passkey)
    const { blobs } = await list({ prefix: legacyPrefix(profile) });
    if (!blobs.length) {
      return NextResponse.json(
        { error: "Profile not found. Create a profile first." },
        { status: 404 }
      );
    }

    // Generate a random challenge
    const challenge = crypto.randomBytes(32).toString("base64url");

    // Generate a user ID from the profile name
    const userId = crypto
      .createHash("sha256")
      .update(normalise(profile))
      .digest("base64url");

    // Store challenge in a short-lived blob for verification
    // (In production, you'd use a proper session store like Redis)
    const challengeKey = `forge/challenges/${userId}`;
    const { put } = await import("@vercel/blob");
    await put(challengeKey, JSON.stringify({ challenge, profile: normalise(profile), expires: Date.now() + 120000 }), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    // RP ID must be consistent between registration and authentication
    // Use the actual domain in production, localhost in dev
    const host = request.headers.get("host") || "";
    const rpId = host.includes("localhost") ? "localhost" : "theforged.fit";

    return NextResponse.json({
      challenge,
      rp: {
        name: "Forge",
        id: rpId,
      },
      user: {
        id: userId,
        name: normalise(profile),
        displayName: profile,
      },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },   // ES256
        { alg: -257, type: "public-key" }, // RS256
      ],
      timeout: 60000,
      authenticatorSelection: {
        authenticatorAttachment: "platform", // Prefer Face ID / Touch ID / Windows Hello
        userVerification: "required",
        residentKey: "preferred",
      },
      attestation: "none",
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
