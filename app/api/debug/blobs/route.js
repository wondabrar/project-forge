import { NextResponse } from "next/server";
import { list } from "@vercel/blob";

// Debug endpoint to list all blobs
// GET /api/debug/blobs?prefix=forge/
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const prefix = searchParams.get("prefix") || "forge/";
    
    const { blobs } = await list({ prefix });
    
    return NextResponse.json({
      prefix,
      count: blobs.length,
      blobs: blobs.map(b => ({
        pathname: b.pathname,
        size: b.size,
        uploadedAt: b.uploadedAt,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
