/**
 * Part 2 — state resolution. Detects the observed event, resolves its governed
 * state (four resolvers, then a deterministic assembler, delta and
 * materiality), and hands material changes to the existing governance control
 * plane. The run streams as RunEvents (SSE), the same as /api/monitor.
 */

import { loadStateResolution } from "@/lib/governance";
import { runStateResolution } from "@/lib/stateResolution";
import { createSseStream, SSE_HEADERS } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const { scenario } = loadStateResolution();
  const { stream, emit, close } = createSseStream();

  (async () => {
    try {
      await runStateResolution(scenario, emit);
    } catch (e) {
      emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      close();
    }
  })();

  return new Response(stream, { headers: SSE_HEADERS });
}
