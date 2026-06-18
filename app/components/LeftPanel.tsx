import type { AgentContract, GovernanceView } from "@/lib/governance";

/** The definitions the viewer reads: agent roster + active policies. */
export function LeftPanel({ view }: { view: GovernanceView }) {
  return (
    <aside className="left-panel">
      <div className="section-label">Governance agent team</div>
      {view.agents.map((a) => (
        <AgentCard key={a.id} agent={a} />
      ))}

      <div className="section-label" style={{ marginTop: "1.5rem" }}>
        Active policies
      </div>
      <div className="card" style={{ padding: "0.4rem 0.85rem" }}>
        {view.policies.map((p) => (
          <div className="policy-row" key={p.key}>
            <span className="pkey">{p.key}</span>
            {p.description && <span className="pdesc">{p.description}</span>}
          </div>
        ))}
      </div>
    </aside>
  );
}

function AgentCard({ agent }: { agent: AgentContract }) {
  return (
    <div className="agent-card">
      <div className="agent-name">
        {agent.name}
        <span className="role-pill">{agent.role_type.replace("_", "-")}</span>
      </div>
      <div className="one-liner">{agent.one_liner}</div>
      <details>
        <summary>Contract</summary>
        <div className="contract-grid">
          <div>
            <div className="k">Authority</div>
            {agent.authority.trim()}
          </div>
          <div>
            <div className="k">Guardrails</div>
            <ul>
              {agent.guardrails.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="k">Escalation</div>
            {agent.escalation_trigger.trim()}
          </div>
          <div>
            <div className="k">Logs</div>
            {agent.logging_obligation.trim()}
          </div>
          <div>
            <div className="k">Verdicts</div>
            {agent.verdicts.join(" · ")}
          </div>
        </div>
      </details>
    </div>
  );
}
