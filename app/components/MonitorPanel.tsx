"use client";

import { useState } from "react";
import type { GovernanceView } from "@/lib/governance";
import { useRun } from "./useRun";
import { RunView } from "./RunView";
import { VerdictBadge } from "./VerdictBadge";

type Format = "json" | "csv" | "other";

export function MonitorPanel({
  view,
  onComplete,
}: {
  view: GovernanceView;
  onComplete: () => void;
}) {
  const [scenarioId, setScenarioId] = useState(view.scenarios[0]?.id ?? "");
  const [format, setFormat] = useState<Format>("json");
  const run = useRun(onComplete);

  return (
    <div>
      <p className="feature-intro">
        The asynchronous monitor catches changes that arrive outside git — a file
        landing, a vendor feed, a manual edit. Pick a scenario, choose a format,
        and simulate a file landing in the environment. The agents evaluate the
        generated data and reach a verdict.
      </p>

      <div className="section-label">Choose a scenario</div>
      <div className="scenario-grid">
        {view.scenarios.map((s) => (
          <button
            key={s.id}
            className={`scenario-card${scenarioId === s.id ? " selected" : ""}`}
            onClick={() => setScenarioId(s.id)}
          >
            <div className="s-label">
              {s.label} <VerdictBadge verdict={s.expected_verdict} />
            </div>
            <div className="s-desc">{s.description.trim()}</div>
          </button>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          gap: "1rem",
          alignItems: "flex-end",
          marginTop: "1.25rem",
        }}
      >
        <div className="field">
          <label htmlFor="format">Format</label>
          <select
            id="format"
            value={format}
            onChange={(e) => setFormat(e.target.value as Format)}
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
            <option value="other">Other (JSON)</option>
          </select>
        </div>
        <button
          className="btn"
          disabled={run.running || !scenarioId}
          onClick={() => run.run("/api/monitor", { scenarioId, format })}
        >
          {run.running ? "Evaluating…" : "Simulate file landing"}
        </button>
      </div>

      <RunView state={run} />
    </div>
  );
}
