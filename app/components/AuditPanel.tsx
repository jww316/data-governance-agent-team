"use client";

import type { AuditEntry } from "@/lib/audit";
import { VerdictBadge } from "./VerdictBadge";

/** The running history — the auditable trail credibility point (§11). */
export function AuditPanel({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="audit-panel">
      <div className="section-label">Audit log — auditable trail</div>
      {entries.length === 0 ? (
        <div className="card empty">
          No runs yet. Each evaluation appends a timestamped record here.
        </div>
      ) : (
        entries.map((e) => (
          <div className="audit-entry" key={e.id}>
            <div className="a-head">
              <VerdictBadge verdict={e.teamVerdict} />
              <span>{e.summary}</span>
              <span className="a-time">{formatTime(e.timestamp)}</span>
            </div>
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
            </div>
          </div>
        ))
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
