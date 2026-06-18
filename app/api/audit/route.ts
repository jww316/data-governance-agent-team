/**
 * Read the audit log for display (IMPLEMENTATION.md §11). Newest first.
 *
 * Entries recorded before the relationship graph existed have no saved `graph`;
 * for those we reconstruct one from the stored agentResults so replay still works
 * (§15.4 — build from stored data). Newer entries carry their real saved graph.
 */

import { loadGovernance } from "@/lib/governance";
import { readAudit } from "@/lib/audit";
import { buildGraph } from "@/lib/graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gov = loadGovernance();
  const roster = gov.agents.map((a) => ({ id: a.id, name: a.name }));

  const entries = readAudit().map((e) => {
    if (e.graph && e.graph.nodes.length > 0) return e;
    return {
      ...e,
      graph: buildGraph({
        roster,
        agentResults: e.agentResults,
        teamVerdict: e.teamVerdict,
        stewards: e.stewards,
        source: e.source,
        summary: e.summary,
        matrixRules: gov.matrix.agent_routing,
      }),
    };
  });

  return new Response(JSON.stringify({ entries }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
