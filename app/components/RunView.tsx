"use client";

import { useEffect, useRef } from "react";
import type { RunEvent, StewardAssignment } from "@/lib/governance";
import type { RosterEntry } from "@/lib/graph";
import type { RunState } from "./useRun";
import { VerdictBadge } from "./VerdictBadge";
import { GovGraphView } from "./GovGraphView";
import { GraphLegend } from "./GraphLegend";

/** Renders the streamed log (the hero element) plus a final result summary. */
export function RunView({
  state,
  roster,
}: {
  state: RunState;
  roster: RosterEntry[];
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [state.events.length]);

  if (state.events.length === 0 && !state.running) return null;

  const assignment = lastOf(state.events, "assignment") as
    | (RunEvent & { type: "assignment" })
    | undefined;
  const github = lastOf(state.events, "github") as
    | (RunEvent & { type: "github" })
    | undefined;
  const audit = lastOf(state.events, "audit_written") as
    | (RunEvent & { type: "audit_written" })
    | undefined;

  return (
    <div className="stream">
      <div className="stream-head">
        <div className="section-label" style={{ margin: 0 }}>
          Live evaluation
        </div>
        {state.running && <span className="spinner" aria-label="running" />}
      </div>

      <div className="event-log">
        {state.events.map((e, i) => (
          <EventRow key={i} event={e} events={state.events} />
        ))}
        {state.running && <PendingRow />}
        <div ref={endRef} />
      </div>

      {state.error && (
        <div className="team-result BLOCK" role="alert">
          <strong>Run error:</strong>&nbsp;{state.error}
        </div>
      )}

      {state.events.some((e) => e.type === "routing") && (
        <div className="graph-section">
          <div className="stream-head">
            <div className="section-label" style={{ margin: 0 }}>
              Relationship path
            </div>
            <GraphLegend />
          </div>
          <GovGraphView events={state.events} roster={roster} />
        </div>
      )}

      {state.teamVerdict && (
        <div className={`team-result ${state.teamVerdict}`}>
          <span className="label">Team verdict</span>
          <VerdictBadge verdict={state.teamVerdict} big />
          <div style={{ flexBasis: "100%" }} />
          {assignment && state.teamVerdict !== "PASS" && (
            <StewardList assignment={assignment.assignment} />
          )}
          {github && <GithubResult github={github} />}
          {audit && (
            <div className="gh-skip">
              Audit entry written: <code>{audit.auditId}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function lastOf(events: RunEvent[], type: RunEvent["type"]) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i];
  }
  return undefined;
}

function PendingRow() {
  return (
    <div className="event running">
      <div className="gutter">
        <span className="spinner" />
      </div>
      <div className="body">
        <div className="detail">Working…</div>
      </div>
    </div>
  );
}

function EventRow({ event, events }: { event: RunEvent; events: RunEvent[] }) {
  switch (event.type) {
    case "run_started":
      return (
        <Row icon="▸" title="Run started" detail={event.change.summary} />
      );

    case "monitor_data":
      return (
        <div className="event">
          <div className="gutter">⬇</div>
          <div className="body">
            <div className="title">
              Data landed — {event.records.length} records ({event.format.toUpperCase()})
            </div>
            <div className="detail">
              Generated within the “{event.label}” scenario boundary.
            </div>
            <div className="data-preview">
              <pre>{JSON.stringify(event.records.slice(0, 4), null, 2)}</pre>
            </div>
          </div>
        </div>
      );

    case "routing":
      return (
        <div className="event">
          <div className="gutter">⤳</div>
          <div className="body">
            <div className="title">
              Routing — {event.agentsSelected.length} agents selected
            </div>
            <div className="detail">{event.agentsSelected.join(" → ")}</div>
            <div className="routing-rules">
              {event.matchedRules.map((r, i) => (
                <div className="rule" key={i}>
                  when {JSON.stringify(r.when)} → {r.invoke.join(", ")}
                </div>
              ))}
            </div>
          </div>
        </div>
      );

    case "agent_started": {
      // Only show the pending line if its result hasn't arrived yet.
      const hasResult = events.some(
        (e) => e.type === "agent_result" && e.agentId === event.agentId
      );
      if (hasResult) return null;
      return (
        <div className="event running">
          <div className="gutter">
            <span className="spinner" />
          </div>
          <div className="body">
            <div className="title">{event.agentName}</div>
            <div className="detail">{event.one_liner}</div>
          </div>
        </div>
      );
    }

    case "agent_result":
      return (
        <div className={`event agent-result ${event.verdict}`}>
          <div className="gutter">●</div>
          <div className="body">
            <div className="title">
              {event.agentName}
              <VerdictBadge verdict={event.verdict} />
            </div>
            <div className="reasoning">{event.reasoning}</div>
          </div>
        </div>
      );

    // Summarized in the result block; not shown inline.
    case "assignment":
    case "team_verdict":
    case "github":
    case "audit_written":
    case "run_complete":
    case "error":
      return null;
  }
}

function Row({
  icon,
  title,
  detail,
}: {
  icon: string;
  title: string;
  detail?: string;
}) {
  return (
    <div className="event">
      <div className="gutter">{icon}</div>
      <div className="body">
        <div className="title">{title}</div>
        {detail && <div className="detail">{detail}</div>}
      </div>
    </div>
  );
}

function StewardList({ assignment }: { assignment: StewardAssignment }) {
  const rows: string[] = [];
  for (const [dim, roles] of Object.entries(assignment.byDimension)) {
    for (const [role, name] of Object.entries(roles)) {
      rows.push(`${pretty(role)} (${dim}): ${name}`);
    }
  }
  if (assignment.crossBorder?.length) {
    rows.push(`Cross-border review: ${assignment.crossBorder.join(", ")}`);
  }
  if (assignment.coverageGap && assignment.fallback) {
    rows.push(`Coverage gap → Governance Lead: ${assignment.fallback}`);
  }
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="label">Assigned stewards</div>
      <ul className="steward-list">
        {rows.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

function GithubResult({
  github,
}: {
  github: RunEvent & { type: "github" };
}) {
  if (github.skipped) {
    return <div className="gh-skip">GitHub: {github.message}</div>;
  }
  return (
    <div className="gh-link">
      Pull request opened —{" "}
      <a href={github.prUrl} target="_blank" rel="noreferrer">
        {github.prUrl}
      </a>{" "}
      <span className="gh-skip">({github.prState})</span>
    </div>
  );
}

function pretty(role: string): string {
  return role
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
