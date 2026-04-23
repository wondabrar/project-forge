import { NextResponse } from "next/server";
import { list, del } from "@vercel/blob";

// Admin endpoint to wipe a profile completely (including credentials)
// DELETE /api/admin/wipe?profile=Name&secret=forge-admin-2024
//
// This bypasses passkey auth for recovery scenarios.
// Protected by a simple secret - not for production use.

const normalise = (name) => String(name || "").trim().toLowerCase();

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const profile = searchParams.get("profile");
    const secret = searchParams.get("secret");
    
    // Simple protection
    if (secret !== "forge-admin-2024") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    if (!profile) {
      return NextResponse.json({ error: "No profile specified" }, { status: 400 });
    }

    const normalised = normalise(profile);
    const prefix = `forge/profiles/${encodeURIComponent(normalised)}/`;
    
    console.log("[admin] Wiping profile:", profile, "prefix:", prefix);
    
    // Find all blobs for this profile
    const { blobs } = await list({ prefix });
    
    console.log("[admin] Found blobs:", blobs.length, blobs.map(b => b.pathname));
    
    if (!blobs.length) {
      return NextResponse.json({ ok: true, deleted: 0, message: "No blobs found" });
    }

    // Delete all blobs
    await del(blobs.map(b => b.url));
    
    return NextResponse.json({ 
      ok: true, 
      deleted: blobs.length,
      paths: blobs.map(b => b.pathname),
    });
  } catch (e) {
    console.error("[admin] Wipe error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
