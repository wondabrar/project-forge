// app/api/cron/cleanup/route.js
// ─────────────────────────────────────────────────────────────────────────────
// Scheduled cleanup of orphaned blobs in the forge/profiles/ namespace.
// Triggered by Vercel Cron Jobs (see vercel.json) — runs daily at 03:00 UTC.
//
// Why this exists:
// Pre-migration, the API used `addRandomSuffix: true` on every PUT, which
// appended a random suffix to each blob URL. The cleanup-before-write logic
// in route.js attempted to delete old blobs before each new write, but races
// and silent failures meant blobs accumulated over time — beta testers saw
// "dozens of files per user" instead of the expected 2 (meta.json + history.json).
//
// Post-migration (allowOverwrite: true), every write goes to the deterministic
// path and overwrites in place. This cron is the safety net that cleans up
// any suffixed legacy blobs left over from the pre-migration era. Once all
// legacy data is gone, this cron is a no-op — but it stays as defence-in-depth.
//
// Auth: Bearer CRON_SECRET (Vercel-injected for cron-triggered requests).
// Manual invocations from outside Vercel without the secret are rejected.
//
// Cost shape: list() is paginated 250-per-call; del() supports batch delete.
// At realistic scale (~10 users × ~2 canonical blobs + occasional legacy
// orphans), single-digit calls per run.
// ─────────────────────────────────────────────────────────────────────────────

import { list, del } from "@vercel/blob";
import { NextResponse } from "next/server";

// Canonical blob paths per profile — these are the ONLY blobs that should
// exist post-migration. Anything else under forge/profiles/{name}/ is an
// orphan eligible for deletion.
const CANONICAL_BASENAMES = new Set(["meta.json", "history.json"]);

export async function GET(request) {
  // ── Auth: require Bearer CRON_SECRET ────────────────────────────────────
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // No CRON_SECRET configured — fail loud so operators notice. Vercel
    // automatically sets this for cron-triggered requests; missing means
    // misconfigured project.
    console.error("[forge:cron-cleanup] CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const stats = { scanned: 0, kept: 0, deleted: 0, errors: 0 };
  const deletedPaths = []; // collected for the response, capped to avoid huge JSON
  const MAX_DELETED_REPORTED = 50;

  try {
    let cursor;

    do {
      const result = await list({
        prefix: "forge/profiles/",
        cursor,
        limit: 250,
      });

      stats.scanned += result.blobs.length;

      // Identify orphans — blobs whose pathname doesn't end in one of the
      // canonical basenames. The pathname shape we want is:
      //   forge/profiles/{encodedName}/meta.json
      //   forge/profiles/{encodedName}/history.json
      // Anything with a random suffix appended (e.g. meta-aBc1Z9.json) or
      // any other unexpected basename is an orphan.
      const orphans = result.blobs.filter(b => {
        // Extract basename — last segment after the final "/"
        const lastSlash = b.pathname.lastIndexOf("/");
        const basename = lastSlash >= 0 ? b.pathname.slice(lastSlash + 1) : b.pathname;
        return !CANONICAL_BASENAMES.has(basename);
      });

      stats.kept += result.blobs.length - orphans.length;

      // Batch delete orphans. del() accepts an array of URLs.
      if (orphans.length > 0) {
        try {
          await del(orphans.map(b => b.url));
          stats.deleted += orphans.length;
          // Collect a sample of deleted paths for the response (capped)
          for (const o of orphans) {
            if (deletedPaths.length < MAX_DELETED_REPORTED) {
              deletedPaths.push(o.pathname);
            }
          }
        } catch (e) {
          console.error("[forge:cron-cleanup] del() failed for batch", e?.message || e);
          stats.errors += orphans.length;
        }
      }

      cursor = result.cursor;
    } while (cursor);

    const elapsedMs = Date.now() - startedAt;
    console.log(`[forge:cron-cleanup] complete in ${elapsedMs}ms`, stats);

    return NextResponse.json({
      ok: true,
      elapsedMs,
      ...stats,
      // Truncate deletedPaths in response if there were many
      deletedSample: deletedPaths,
      truncated: stats.deleted > deletedPaths.length,
    });
  } catch (e) {
    console.error("[forge:cron-cleanup] fatal", e);
    return NextResponse.json(
      { error: e.message || "cleanup failed", ...stats },
      { status: 500 }
    );
  }
}
