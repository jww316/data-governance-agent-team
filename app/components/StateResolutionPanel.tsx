"use client";

import type { GovernanceView } from "@/lib/governance";
import { useRun } from "./useRun";
import { RunView } from "./RunView";
import { VerdictBadge } from "./VerdictBadge";
import { StateResolutionView } from "./StateResolutionView";

/**
 * Part 2: state resolution. This tab adds a stage UPSTREAM of Part 1. Its run
 * continues into the same live log, relationship path, verdict and audit trail
 * as the other two features.
 */
export function StateResolutionPanel({
  view,
  onComplete,
}: {
  view: GovernanceView;
  onComplete: () => void;
}) {
  const run = useRun(onComplete);
  const { scenario, resolvers } = view.stateResolution;

  return (
    <div>
      <p className="feature-intro">
        Before the decision-rights matrix can decide which agents act, something has
        to establish the governed state of the data. A change is observed. Four
        specialized resolvers establish what is now true. Deterministic rules compare
        that to what was true before and decide whether anything governance-relevant
        changed. Only then does the existing control plane decide who has authority
        and whether the change is permitted.
      </p>

      <div className="section-label">Scenario</div>
      <div className="scenario-grid">
        <div className="scenario-card selected" style={{ cursor: "default" }}>
          <div className="s-label">
            {scenario.label} <VerdictBadge verdict={scenario.expected_verdict} />
          </div>
          <div className="s-desc">{scenario.description.trim()}</div>
        </div>
      </div>

      <div style={{ marginTop: "1.25rem" }}>
        <button
          className="btn"
          disabled={run.running}
          onClick={() => run.run("/api/state-resolution", {})}
        >
          {run.running ? "Resolving…" : "Detect integration & resolve state"}
        </button>
      </div>

      <StateResolutionView events={run.events} resolvers={resolvers} />

      <RunView
        state={run}
        roster={view.agents.map((a) => ({ id: a.id, name: a.name }))}
      />
    </div>
  );
}
