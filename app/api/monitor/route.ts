/**
 * Feature 2 — asynchronous monitor (file landing). Generates data within a
 * scenario's boundary, routes + runs the agents, and streams RunEvents (SSE).
 */

import { NextRequest } from "next/server";
import { loadGovernance } from "@/lib/governance";
import { buildMonitorChange } from "@/lib/adapters";
import { OutputFormat } from "@/lib/generator";
import { runGovernance } from "@/lib/orchestrator";
import { createSseStream, SSE_HEADERS } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    scenarioId?: string;
    format?: OutputFormat;
    count?: number;
  };

  const gov = loadGovernance();
  const scenario = gov.scenarios.find((s) => s.id === body.scenarioId);
  if (!scenario) {
    return new Response(
      JSON.stringify({ error: `Unknown scenario: ${body.scenarioId}` }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { change, generated, format } = buildMonitorChange(
    scenario,
    body.format ?? "json",
    body.count ?? 10
  );

  const { stream, emit, close } = createSseStream();

  (async () => {
    try {
      // Surface the generated data first so the viewer sees what landed.
      emit({
        type: "monitor_data",
        scenarioId: scenario.id,
        label: scenario.label,
        format,
        records: generated.records,
        fieldMeta: generated.fieldMeta,
      });
      await runGovernance(change, emit);
    } catch (e) {
      emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      close();
    }
  })();

  return new Response(stream, { headers: SSE_HEADERS });
}
