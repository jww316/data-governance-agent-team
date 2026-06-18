/**
 * sse.ts — a tiny Server-Sent Events helper for the API routes. Each emitted
 * value is serialized as one `data:` frame (IMPLEMENTATION.md §7, DESIGN.md §8).
 */

import { RunEvent } from "./governance";

export interface SseStream {
  stream: ReadableStream<Uint8Array>;
  emit: (event: RunEvent) => void;
  close: () => void;
}

export function createSseStream(): SseStream {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });

  const emit = (event: RunEvent) => {
    if (closed) return;
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      /* already closed */
    }
  };

  return { stream, emit, close };
}

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};
