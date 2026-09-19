"use client";

import type { ReactNode } from "react";
import type {
  ResolverContract,
  ResolverResult,
  RunEvent,
} from "@/lib/governance";

/**
 * The Part 2 stages: event → resolver team → resolved state → delta →
 * materiality. It renders from the RunEvent stream alone, so the same component
 * serves the live run and the audit replay. Evidence and provenance sit behind
 * <details>, so the main view stays readable.
 */
export function StateResolutionView({
  events,
  resolvers,
}: {
  events: RunEvent[];
  /** Resolver contracts, for questions and guardrails (optional on replay). */
  resolvers?: ResolverContract[];
}) {
  const observed = pick(events, "observed_event");
  if (!observed) return null;

  const started = pick(events, "state_resolution_started");
  const results = new Map<string, ResolverResult>();
  for (const e of events) if (e.type === "resolver_result") results.set(e.result.resolverId, e.result);
  const assembled = pick(events, "state_assembled");
  const delta = pick(events, "state_delta");
  const materiality = pick(events, "materiality");
  const complete = pick(events, "state_resolution_complete");
  const handoff = pick(events, "governance_handoff");
  const contracts = new Map((resolvers ?? []).map((r) => [r.id, r]));

  const oc = observed.event.observed_change;

  return (
    <div className="sr-stages">
      {/* Stage 1 — Event ------------------------------------------------- */}
      <Stage n={1} title="Observed event" tag="change awareness">
        <div className="sr-event">
          <div className="sr-event-head">
            <code>{observed.event.event_id}</code>
            <span className="sr-muted">{observed.event.event_type}</span>
          </div>
          <div className="sr-flow">
            <span className="sr-sys">{oc.source_system}</span>
            <span className="sr-muted">.{oc.source_structure}</span>
            <span className="sr-arrow">→ {oc.mechanism} →</span>
            <span className="sr-sys">{oc.destination_system}</span>
            <span className="sr-muted">.{oc.destination_structure}</span>
          </div>
          <div className="sr-chips">
            {observed.event.fields.map((f) => (
              <code key={f} className="sr-chip">
                {f}
              </code>
            ))}
          </div>
          {observed.event.integration && (
            <div className="sr-muted sr-small">
              <code>{observed.event.integration.name}</code>:{" "}
              {observed.event.integration.description}
            </div>
          )}
          <p className="sr-note">
            The event records observed facts. It does not say whether this is PII, where
            the data goes, or why. Those facts are resolved next.
          </p>
          <details className="sr-details">
            <summary>
              Evidence examined ({Object.keys(observed.evidence).length} families)
            </summary>
            {Object.entries(observed.evidence).map(([family, body]) => (
              <div key={family} className="sr-evidence">
                <div className="sr-evidence-name">{human(family)}</div>
                <pre>{JSON.stringify(body, null, 2)}</pre>
              </div>
            ))}
          </details>
        </div>
      </Stage>

      {/* Stage 2 — Resolver team ----------------------------------------- */}
      {started && (
        <Stage n={2} title="Resolver team" tag="independent · in parallel">
          <div className="sr-resolvers">
            {started.resolvers.map((r) => (
              <ResolverCard
                key={r.id}
                name={r.name}
                plannedMethod={r.method}
                result={results.get(r.id)}
                contract={contracts.get(r.id)}
              />
            ))}
          </div>
        </Stage>
      )}

      {/* Stage 3 — Resolved state ---------------------------------------- */}
      {assembled && (
        <Stage n={3} title="Resolved state" tag="deterministic assembler">
          {assembled.ok ? (
            <>
              <div className="sr-state-grid">
                {Object.entries(assembled.routingState).map(([k, v]) => {
                  const p = assembled.provenance[k];
                  return (
                    <div
                      className="sr-state"
                      key={k}
                      title={
                        p
                          ? `${p.resolver} · ${p.method} · confidence ${p.confidence.toFixed(2)}\n${p.evidence.join("\n")}`
                          : undefined
                      }
                    >
                      <span className="sr-state-k">{label(k)}</span>
                      <span className="sr-state-v">{fmt(v)}</span>
                    </div>
                  );
                })}
              </div>
              {assembled.derivedState && (
                <div className="sr-derived">
                  <span className="sr-muted sr-small">Derived (rules, no model):</span>
                  {Object.entries(assembled.derivedState).map(([k, v]) => (
                    <code key={k} className={`sr-flag${v ? " on" : ""}`}>
                      {k} = {String(v)}
                    </code>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="sr-stop">
              <strong>State {assembled.status}.</strong> Stopped before governance
              routing. Nothing was assumed.
              <ul>
                {assembled.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </Stage>
      )}

      {/* Stage 4 — Delta ------------------------------------------------- */}
      {delta && (
        <Stage n={4} title="Prior state vs. new state" tag="deterministic">
          {delta.delta.firstObservation && (
            <p className="sr-note">No prior state on record. This is a first observation.</p>
          )}
          <table className="sr-delta">
            <thead>
              <tr>
                <th>Attribute</th>
                <th>Previous</th>
                <th>Current</th>
                <th>Changed</th>
              </tr>
            </thead>
            <tbody>
              {delta.delta.entries.map((e) => (
                <tr key={e.attribute} className={e.changed ? "changed" : ""}>
                  <td>{label(e.attribute)}</td>
                  <td>{fmt(e.prior)}</td>
                  <td>{fmt(e.current)}</td>
                  <td>{e.changed ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!delta.delta.firstObservation && delta.delta.entries.some((e) => e.changed) && (
            <p className="sr-note">
              The customer records are the same. Their context changed, so their
              governed state changed.
            </p>
          )}
        </Stage>
      )}

      {/* Stage 5 — Materiality ------------------------------------------- */}
      {materiality && (
        <Stage n={5} title="Governance materiality" tag="configured rules">
          <div className={`sr-material ${materiality.result.material ? "yes" : "no"}`}>
            Governance material change:{" "}
            <strong>{materiality.result.material ? "YES" : "NO"}</strong>
          </div>
          <ul className="sr-reasons">
            {materiality.result.materialChanges.map((a) => (
              <li key={a}>
                <strong>{label(a)}</strong>: {materiality.result.reasons[a]}
              </li>
            ))}
            {materiality.result.nonMaterialChanges.map((a) => (
              <li key={a} className="sr-muted">
                {label(a)}: {materiality.result.reasons[a]} (not material)
              </li>
            ))}
          </ul>
        </Stage>
      )}

      {complete && (
        <div className={`sr-handoff ${complete.outcome}`}>
          <span className="sr-handoff-arrow">↓</span>
          <div>
            <div>{complete.message}</div>
            {handoff && (
              <details className="sr-details">
                <summary>Routing input handed to the decision-rights matrix</summary>
                <pre>{JSON.stringify(handoff.input, null, 2)}</pre>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ResolverCard({
  name,
  plannedMethod,
  result,
  contract,
}: {
  name: string;
  plannedMethod: string;
  result?: ResolverResult;
  contract?: ResolverContract;
}) {
  const method = result?.method ?? plannedMethod;
  return (
    <div className={`sr-resolver ${result?.status ?? "running"}`}>
      <div className="sr-resolver-head">
        <span className="sr-resolver-name">{name}</span>
        {result ? (
          <span className={`sr-status ${result.status}`}>{result.status}</span>
        ) : (
          <span className="spinner" aria-label="running" />
        )}
      </div>
      <div className="sr-method">
        {method === "model" ? "Model reasoning" : "Authoritative lookup"}
      </div>
      {contract && <div className="sr-question">{contract.question}</div>}
      {result && (
        <>
          {Object.entries(result.attributes).map(([k, a]) => (
            <div className="sr-attr" key={k}>
              <div className="sr-attr-row">
                <code>{k}</code>
                <span className="sr-attr-v">{fmt(a.value)}</span>
              </div>
              <div className="sr-conf">
                <span className="sr-conf-bar">
                  <span style={{ width: `${Math.round(a.confidence * 100)}%` }} />
                </span>
                <span className="sr-conf-n">{a.confidence.toFixed(2)}</span>
              </div>
            </div>
          ))}
          <div className="sr-summary">{result.summary}</div>
          <details className="sr-details">
            <summary>Provenance</summary>
            {Object.entries(result.attributes).map(([k, a]) => (
              <div key={k} className="sr-prov">
                <code>{k}</code> ← {a.evidence.join(", ") || "(none cited)"}
              </div>
            ))}
            <div className="sr-prov sr-muted">
              {result.resolverId} · resolved {new Date(result.resolvedAt).toLocaleString()}
            </div>
            {result.issues?.map((i, n) => (
              <div key={n} className="sr-prov sr-issue">
                {i}
              </div>
            ))}
            {result.conflicts?.map((c, n) => (
              <div key={n} className="sr-prov sr-issue">
                Conflict on <code>{c.attribute}</code>: {c.note} ({c.evidence.join(" vs ")})
              </div>
            ))}
            {contract?.guardrails.map((g, n) => (
              <div key={n} className="sr-prov sr-muted">
                Guardrail: {g}
              </div>
            ))}
          </details>
        </>
      )}
    </div>
  );
}

function Stage({
  n,
  title,
  tag,
  children,
}: {
  n: number;
  title: string;
  tag: string;
  children: ReactNode;
}) {
  return (
    <section className="sr-stage">
      <div className="sr-stage-head">
        <span className="sr-stage-n">{n}</span>
        <span className="sr-stage-title">{title}</span>
        <span className="sr-stage-tag">{tag}</span>
      </div>
      <div className="sr-stage-body">{children}</div>
    </section>
  );
}

function pick<T extends RunEvent["type"]>(
  events: RunEvent[],
  type: T
): Extract<RunEvent, { type: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i] as Extract<RunEvent, { type: T }>;
  }
  return undefined;
}

const LABELS: Record<string, string> = {
  contains_pii: "Contains PII",
  classification: "Classification",
  origin_location: "Origin",
  destination_location: "Destination",
  recipient_type: "Recipient",
  processing_purpose: "Purpose",
};

function label(k: string): string {
  return LABELS[k] ?? human(k);
}

function human(s: string): string {
  return s.replace(/_/g, " ");
}

function fmt(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return human(v);
  return JSON.stringify(v);
}
