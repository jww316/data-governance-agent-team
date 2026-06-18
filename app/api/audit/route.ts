/**
 * Read the audit log for display (IMPLEMENTATION.md §11). Newest first.
 */

import { readAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const entries = readAudit();
  return new Response(JSON.stringify({ entries }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
