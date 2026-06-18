/**
 * Feature 1 — synchronous gate (PR evaluation). Computes the change as a diff
 * against the schema baseline, routes + runs the agents, opens a real PR on the
 * throwaway repo with the verdict, and streams RunEvents (SSE).
 */

import { NextRequest } from "next/server";
import { getTable } from "@/lib/governance";
import { EditOp, buildGateChange } from "@/lib/adapters";
import { runGovernance } from "@/lib/orchestrator";
import { openGovernancePr } from "@/lib/github";
import { createSseStream, SSE_HEADERS } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    table?: string;
    edits?: EditOp[];
  };

  const tableName = body.table ?? "customers";
  const edits = body.edits ?? [];

  let table;
  try {
    table = getTable(tableName);
  } catch {
    return new Response(
      JSON.stringify({ error: `Unknown table: ${tableName}` }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { change, nextColumns } = buildGateChange(tableName, table, edits);

  const { stream, emit, close } = createSseStream();

  (async () => {
    try {
      await runGovernance(change, emit, {
        onGithub: async ({ teamVerdict, agentResults, assignment }) =>
          openGovernancePr({
            tableName,
            summary:
              change.diff &&
              [
                ...change.diff.added.map((c) => `+${c.name}`),
                ...change.diff.altered.map((c) => `~${c.name}`),
                ...change.diff.removed.map((c) => `-${c.name}`),
              ].join(", ") || "no-op",
            diff: change.diff!,
            nextColumns,
            teamVerdict,
            agentResults,
            assignment,
          }),
      });
    } catch (e) {
      emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      close();
    }
  })();

  return new Response(stream, { headers: SSE_HEADERS });
}
