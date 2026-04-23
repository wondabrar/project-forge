import { NextResponse } from "next/server";
import { list, del } from "@vercel/blob";

// Admin endpoint to wipe profiles completely (including credentials)
// DELETE /api/admin/wipe?profile=Name&secret=forge-admin-2024  - wipe single profile
// DELETE /api/admin/wipe?all=true&secret=forge-admin-2024      - wipe ALL profiles
//
// This bypasses passkey auth for recovery scenarios.
// Protected by a simple secret - not for production use.

const normalise = (name) => String(name || "").trim().toLowerCase();

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const profile = searchParams.get("profile");
    const wipeAll = searchParams.get("all") === "true";
    const secret = searchParams.get("secret");
    
    // Simple protection
    if (secret !== "forge-admin-2024") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    let prefix;
    if (wipeAll) {
      // Wipe everything under forge/
      prefix = "forge/";
    } else if (profile) {
      const normalised = normalise(profile);
      prefix = `forge/profiles/${encodeURIComponent(normalised)}/`;
    } else {
      return NextResponse.json({ error: "Specify profile or all=true" }, { status: 400 });
    }
    
    // Find all blobs
    const { blobs } = await list({ prefix });
    
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
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
