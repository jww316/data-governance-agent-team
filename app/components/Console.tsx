"use client";

import { useCallback, useEffect, useState } from "react";
import type { GovernanceView } from "@/lib/governance";
import type { AuditEntry } from "@/lib/audit";
import { LeftPanel } from "./LeftPanel";
import { GateEditor } from "./GateEditor";
import { MonitorPanel } from "./MonitorPanel";
import { AuditPanel } from "./AuditPanel";
import "./console.css";

type Tab = "gate" | "monitor";

export function Console({ view }: { view: GovernanceView }) {
  const [tab, setTab] = useState<Tab>("monitor");
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  const refreshAudit = useCallback(async () => {
    try {
      const resp = await fetch("/api/audit", { cache: "no-store" });
      const data = (await resp.json()) as { entries: AuditEntry[] };
      setEntries(data.entries ?? []);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    refreshAudit();
  }, [refreshAudit]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <h1>Data Governance Agent Team</h1>
          <span className="tagline">Governance as an operational control plane</span>
        </div>
        <span className="disclaimer">Illustrative reference implementation — not production</span>
      </header>

      <div className="app-body">
        <LeftPanel view={view} />

        <main className="right-region">
          <div className="tabs">
            <button
              className={tab === "monitor" ? "active" : ""}
              onClick={() => setTab("monitor")}
            >
              Feature 2 · Async monitor
            </button>
            <button
              className={tab === "gate" ? "active" : ""}
              onClick={() => setTab("gate")}
            >
              Feature 1 · Sync gate (PR)
            </button>
          </div>

          {tab === "monitor" ? (
            <MonitorPanel view={view} onComplete={refreshAudit} />
          ) : (
            <GateEditor view={view} onComplete={refreshAudit} />
          )}

          <AuditPanel entries={entries} />
        </main>
      </div>
    </div>
  );
}
