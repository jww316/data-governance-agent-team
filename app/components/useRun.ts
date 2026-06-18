"use client";

import { useCallback, useRef, useState } from "react";
import type { RunEvent, Verdict } from "@/lib/governance";

export interface RunState {
  events: RunEvent[];
  running: boolean;
  teamVerdict: Verdict | null;
  error: string | null;
}

const initial: RunState = {
  events: [],
  running: false,
  teamVerdict: null,
  error: null,
};

/**
 * Runs a POST against an SSE endpoint, parsing `data:` frames into RunEvents.
 * EventSource only supports GET, so we read the stream manually.
 */
export function useRun(onComplete?: () => void) {
  const [state, setState] = useState<RunState>(initial);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (url: string, body: unknown) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({ events: [], running: true, teamVerdict: null, error: null });

      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Request failed (${resp.status}). ${text}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!line) continue;
            const json = line.slice("data:".length).trim();
            if (!json) continue;
            let event: RunEvent;
            try {
              event = JSON.parse(json) as RunEvent;
            } catch {
              continue;
            }
            setState((s) => {
              const next: RunState = { ...s, events: [...s.events, event] };
              if (event.type === "team_verdict") next.teamVerdict = event.verdict;
              if (event.type === "error") next.error = event.message;
              return next;
            });
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setState((s) => ({
          ...s,
          error: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setState((s) => ({ ...s, running: false }));
        onComplete?.();
      }
    },
    [onComplete]
  );

  return { ...state, run };
}
