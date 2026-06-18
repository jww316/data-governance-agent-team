"use client";

import { useState } from "react";
import type { AuditEntry } from "@/lib/audit";
import { VerdictBadge } from "./VerdictBadge";
import { GovGraphView } from "./GovGraphView";
import { GraphLegend } from "./GraphLegend";

/** The running history — the auditable trail credibility point (§11, §15.5). */
export function AuditPanel({ entries }: { entries: AuditEntry[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="audit-panel">
      <div className="section-label">Audit log — auditable trail</div>
      {entries.length === 0 ? (
        <div className="card empty">
          No runs yet. Each evaluation appends a timestamped record here.
        </div>
      ) : (
        entries.map((e) => {
          const open = openId === e.id;
          const hasGraph = Boolean(e.graph && e.graph.nodes.length > 0);
          return (
            <div className="audit-entry" key={e.id}>
              <button
                className="a-head a-toggle"
                onClick={() => setOpenId(open ? null : e.id)}
                aria-expanded={open}
              >
                <span className={`a-caret${open ? " open" : ""}`}>▸</span>
                <VerdictBadge verdict={e.teamVerdict} />
                <span>{e.summary}</span>
                <span className="a-time">{formatTime(e.timestamp)}</span>
              </button>
              <div className="a-summary">
                {e.source} · {e.agentResults.length} agents ·{" "}
                {e.github && !e.github.skipped && e.github.prUrl ? (
                  <a href={e.github.prUrl} target="_blank" rel="noreferrer">
                    PR
                  </a>
                ) : (
                  "no PR"
                )}{" "}
                · <span className="a-id">{e.id}</span>
                {hasGraph && (
                  <>
                    {" "}
                    ·{" "}
                    <button className="a-replay" onClick={() => setOpenId(open ? null : e.id)}>
                      {open ? "hide path" : "replay path"}
                    </button>
                  </>
                )}
              </div>
              {open && hasGraph && (
                <div className="a-graph">
                  <div className="stream-head">
                    <div className="section-label" style={{ margin: 0 }}>
                      Saved relationship path
                    </div>
                    <GraphLegend />
                  </div>
                  <GovGraphView graph={e.graph!} />
                </div>
              )}
              {open && !hasGraph && (
                <div className="a-graph empty">
                  No saved graph for this run (recorded before the relationship graph
                  was added).
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
