/**
 * graph.ts — the pure relationship-graph builder (IMPLEMENTATION.md §15).
 *
 * Builds a serializable node/edge graph of the path a request took through the
 * governed data, derived ENTIRELY from the existing RunEvent stream (§15.4). No
 * new orchestrator logic — this is a second view over data already produced.
 * The same builder feeds the live view and the persisted audit-replay view.
 */

import {
  AgentResult,
  MatrixRoutingRule,
  ResolverStatus,
  RunEvent,
  StewardAssignment,
  Verdict,
} from "./governance";

/**
 * Column index, left to right. A Part 1 run uses 0–5. A Part 2 run adds four
 * upstream columns (event, resolvers, state delta, materiality), and the Part 1
 * columns shift right by PART2_OFFSET.
 */
export type GraphColumn = number;
const PART2_OFFSET = 4;

export interface GraphNode {
  id: string;
  kind:
    | "origin"
    | "state"
    | "agent"
    | "policy"
    | "outcome"
    | "steward"
    // Part 2 (state resolution)
    | "event"
    | "resolver"
    | "delta"
    | "materiality";
  label: string;
  sublabel?: string;
  column: GraphColumn;
  /** Invoked agents are active; un-invoked agents are grayed (§15.2/15.3). */
  active: boolean;
  verdict?: Verdict;
  /** Part 2: resolver status, or "changed"/"unchanged" for delta nodes. */
  status?: ResolverStatus | "changed" | "unchanged" | "material" | "not_material";
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  verdict?: Verdict;
  /** The blocking/escalating path is emphasized (§15.3). */
  emphasized?: boolean;
}

export interface GovGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RosterEntry {
  id: string;
  name: string;
}

/**
 * Fallback mapping of which named policy each agent evaluates, used when an
 * agent_result's `details.policies_evaluated` is absent. Keeps the policy column
 * meaningful and the acceptance paths (Classification→pii_protection,
 * Policy→cross_border) reliable even if the model omits the list.
 */
const DEFAULT_POLICIES: Record<string, string[]> = {
  classification_pii: ["pii_protection"],
  policy_jurisdiction: ["cross_border"],
  quality: ["quality_rules"],
  relationship_lineage: [],
  assignment_steward: [],
};

const SEVERITY: Record<Verdict, number> = { PASS: 0, ESCALATE: 1, BLOCK: 2 };
function strongest(a: Verdict | undefined, b: Verdict | undefined): Verdict {
  const av = a ? SEVERITY[a] : -1;
  const bv = b ? SEVERITY[b] : -1;
  return av >= bv ? (a ?? b ?? "PASS") : (b ?? "PASS");
}

// --- Event extraction helpers ----------------------------------------------

function find<T extends RunEvent["type"]>(
  events: RunEvent[],
  type: T
): Extract<RunEvent, { type: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i] as Extract<RunEvent, { type: T }>;
  }
  return undefined;
}

function policiesFor(agentId: string, details: unknown): string[] {
  const d = details as { policies_evaluated?: unknown } | undefined;
  const fromDetails = Array.isArray(d?.policies_evaluated)
    ? d!.policies_evaluated.filter((x): x is string => typeof x === "string")
    : [];
  const list = fromDetails.length ? fromDetails : DEFAULT_POLICIES[agentId] ?? [];
  return Array.from(new Set(list));
}

// --- The builder ------------------------------------------------------------

/** Build live, from the run's own event stream. */
export interface GraphFromEvents {
  events: RunEvent[];
  roster: RosterEntry[];
}

/**
 * Reconstruct from a stored audit entry that has no saved graph (a run recorded
 * before the graph existed). The routing event is not stored, so the matched
 * matrix rules are re-derived by reverse-mapping the invoked agents against the
 * matrix (`matrixRules`); pass them so the state→agent edges stay labeled.
 */
export interface GraphFromAudit {
  roster: RosterEntry[];
  agentResults: AgentResult[];
  teamVerdict: Verdict;
  stewards?: StewardAssignment;
  source?: string;
  summary?: string;
  matrixRules?: MatrixRoutingRule[];
}

export type GraphInput = GraphFromEvents | GraphFromAudit;

/**
 * Build the relationship graph. Accepts either a live RunEvent stream or a
 * stored audit entry (reconstructed into the equivalent events). Deterministic
 * and serializable; the same output feeds the live and replay views.
 */
export function buildGraph(input: GraphInput): GovGraph {
  if ("events" in input) {
    return buildFromEvents(input.events, input.roster);
  }
  return buildFromEvents(auditToEvents(input), input.roster);
}

/**
 * Synthesize the RunEvents an audit entry would have emitted, so a saved entry
 * with no graph can be reconstructed through the very same builder.
 */
function auditToEvents(a: GraphFromAudit): RunEvent[] {
  const invoked = a.agentResults.map((r) => r.agentId);
  const matchedRules = reconstructMatchedRules(invoked, a.matrixRules ?? []);

  const events: RunEvent[] = [
    {
      type: "run_started",
      change: { summary: a.summary ?? "", source: a.source ?? "monitor" },
    },
    { type: "routing", agentsSelected: invoked, matchedRules },
    ...a.agentResults.map(
      (r): RunEvent => ({
        type: "agent_result",
        agentId: r.agentId,
        agentName: r.agentName,
        verdict: r.verdict,
        reasoning: r.reasoning,
        details: r.details,
      })
    ),
  ];
  if (a.stewards) events.push({ type: "assignment", assignment: a.stewards });
  events.push({ type: "team_verdict", verdict: a.teamVerdict });
  return events;
}

/**
 * Re-derive which matrix rules matched from the set of agents that actually ran.
 * Without the original routing facts this is best-effort: a rule is taken as
 * matched only when it explains an invoked agent not already explained by an
 * earlier (more specific) rule — which avoids inventing state nodes for triggers
 * that did not fire. Newer runs always carry the real saved graph, so this path
 * serves only pre-graph audit history.
 */
function reconstructMatchedRules(
  invoked: string[],
  rules: MatrixRoutingRule[]
): MatrixRoutingRule[] {
  const invokedSet = new Set(invoked);
  const covered = new Set<string>();
  const selected: MatrixRoutingRule[] = [];

  for (const rule of rules) {
    const isAlways = rule.when.always === true;
    const newlyExplained = rule.invoke.filter(
      (id) => invokedSet.has(id) && !covered.has(id)
    );
    if (isAlways) {
      if (rule.invoke.some((id) => invokedSet.has(id))) {
        selected.push(rule);
        rule.invoke.forEach((id) => covered.add(id));
      }
    } else if (newlyExplained.length > 0) {
      selected.push(rule);
      rule.invoke.forEach((id) => invokedSet.has(id) && covered.add(id));
    }
  }
  return selected;
}

function buildFromEvents(events: RunEvent[], roster: RosterEntry[]): GovGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeMap = new Map<string, GraphEdge>();

  const addNode = (n: GraphNode) => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };
  const addEdge = (e: GraphEdge) => {
    const existing = edgeMap.get(e.id);
    if (existing) {
      existing.verdict = strongest(existing.verdict, e.verdict);
      existing.emphasized = existing.emphasized || e.emphasized;
      return;
    }
    edgeMap.set(e.id, e);
    edges.push(e);
  };

  const started = find(events, "run_started");
  const monitorData = find(events, "monitor_data");
  const routing = find(events, "routing");
  const assignment = find(events, "assignment");
  const teamVerdictEvent = find(events, "team_verdict");
  const teamVerdict: Verdict = teamVerdictEvent?.verdict ?? "PASS";
  const emphasize = teamVerdict !== "PASS";

  const results = new Map<
    string,
    { verdict: Verdict; details: unknown }
  >();
  for (const e of events) {
    if (e.type === "agent_result")
      results.set(e.agentId, { verdict: e.verdict, details: e.details });
  }

  // --- Part 2 upstream path (only for runs that began with state resolution) --
  const part2 = buildStateResolutionPath(events, addNode, addEdge, teamVerdict);
  const off = part2 ? PART2_OFFSET : 0;

  // --- Column 0: Origin ------------------------------------------------------
  // In a Part 2 run, the materiality / hand-off node is the origin of the Part 1
  // path, so the two halves read as one chain.
  const originId = part2 ? part2.handoffId : "origin";
  if (!part2) {
    const originLabel =
      monitorData?.label ??
      started?.change.summary ??
      "Request";
    addNode({
      id: "origin",
      kind: "origin",
      label: originLabel,
      sublabel: started?.change.source,
      column: 0,
      active: true,
    });
  }

  // --- Column 1: State attributes that participated in routing ---------------
  // Derived from the keys of the matrix rules that actually matched.
  const matchedRules = routing?.matchedRules ?? [];
  const selected = new Set(routing?.agentsSelected ?? []);

  for (const rule of matchedRules) {
    for (const [key, value] of Object.entries(rule.when)) {
      const stateId = `state:${key}`;
      addNode({
        id: stateId,
        kind: "state",
        label: key === "always" ? "always" : `${key} = ${value}`,
        column: off + 1,
        active: true,
      });
      addEdge({
        id: `e:${originId}->${stateId}`,
        source: originId,
        target: stateId,
        label: part2 && key !== "always" ? "hand-off" : undefined,
      });
    }
  }

  // --- Column 2: Agents (full roster; un-invoked grayed) ---------------------
  for (const r of roster) {
    const invoked = selected.has(r.id);
    const res = results.get(r.id);
    addNode({
      id: `agent:${r.id}`,
      kind: "agent",
      label: r.name,
      column: off + 2,
      active: invoked,
      verdict: invoked ? res?.verdict : undefined,
    });
  }

  // State -> Agent edges, labeled with the matched matrix rule (§15.2).
  for (const rule of matchedRules) {
    const keys = Object.keys(rule.when);
    for (const agentId of rule.invoke) {
      if (!selected.has(agentId)) continue;
      const v = results.get(agentId)?.verdict;
      for (const key of keys) {
        addEdge({
          id: `e:state:${key}->agent:${agentId}`,
          source: `state:${key}`,
          target: `agent:${agentId}`,
          label: `matched: ${key}`,
          verdict: v,
          emphasized: emphasize && v === teamVerdict,
        });
      }
    }
  }

  // --- Column 3: Policies + Column 4: Outcome --------------------------------
  addNode({
    id: "outcome",
    kind: "outcome",
    label: teamVerdict,
    column: off + 4,
    active: true,
    verdict: teamVerdict,
  });

  // Part 2 runs that never reached the agent team (not material, or state not
  // established) connect straight to the outcome.
  if (part2?.bypass) {
    addEdge({
      id: `e:${part2.bypass.from}->outcome`,
      source: part2.bypass.from,
      target: "outcome",
      label: part2.bypass.label,
      verdict: teamVerdict,
      emphasized: emphasize,
    });
  }

  const policyVerdict = new Map<string, Verdict>();
  for (const r of roster) {
    if (!selected.has(r.id)) continue; // grayed agents have no outgoing edges
    const res = results.get(r.id);
    const v = res?.verdict ?? "PASS";
    const pols = policiesFor(r.id, res?.details);

    if (pols.length === 0) {
      // No named policy — connect the agent straight to the outcome (§15.2).
      addEdge({
        id: `e:agent:${r.id}->outcome`,
        source: `agent:${r.id}`,
        target: "outcome",
        verdict: v,
        emphasized: emphasize && v === teamVerdict,
      });
      continue;
    }

    for (const p of pols) {
      const policyId = `policy:${p}`;
      addNode({
        id: policyId,
        kind: "policy",
        label: p,
        column: off + 3,
        active: true,
        verdict: v,
      });
      policyVerdict.set(p, strongest(policyVerdict.get(p), v));
      addEdge({
        id: `e:agent:${r.id}->${policyId}`,
        source: `agent:${r.id}`,
        target: policyId,
        verdict: v,
        emphasized: emphasize && v === teamVerdict,
      });
      addEdge({
        id: `e:${policyId}->outcome`,
        source: policyId,
        target: "outcome",
        verdict: v,
        emphasized: emphasize && v === teamVerdict,
      });
    }
  }
  // Reconcile policy node colors to the strongest contributing verdict.
  for (const n of nodes) {
    if (n.kind === "policy") n.verdict = policyVerdict.get(n.label) ?? n.verdict;
  }

  // --- Column 5: Stewards (on ESCALATE / BLOCK needing an owner) -------------
  if (assignment && teamVerdict !== "PASS") {
    const a = assignment.assignment;
    const stewardLabels = new Map<string, string>(); // name -> role/context

    for (const [dim, roles] of Object.entries(a.byDimension ?? {})) {
      for (const [role, name] of Object.entries(roles)) {
        if (!stewardLabels.has(name))
          stewardLabels.set(name, `${prettyRole(role)} · ${dim}`);
      }
    }
    for (const name of a.crossBorder ?? []) {
      if (!stewardLabels.has(name)) stewardLabels.set(name, "cross-border review");
    }
    if (a.coverageGap && a.fallback) {
      stewardLabels.set(a.fallback, "coverage gap → governance lead");
    }
    if (a.humanReview) {
      stewardLabels.set(a.humanReview.steward, "state review → governance lead");
    }

    for (const [name, context] of stewardLabels) {
      const stewardId = `steward:${name}`;
      addNode({
        id: stewardId,
        kind: "steward",
        label: name,
        sublabel: context,
        column: off + 5,
        active: true,
        verdict: teamVerdict,
      });
      addEdge({
        id: `e:outcome->${stewardId}`,
        source: "outcome",
        target: stewardId,
        verdict: teamVerdict,
        emphasized: true,
      });
    }
  }

  return { nodes, edges };
}

// --- Part 2: the upstream state-resolution path ------------------------------

interface Part2Path {
  /** The node the Part 1 routing path grows from (the materiality hand-off). */
  handoffId: string;
  /** Set when the run never reached the agent team. */
  bypass?: { from: string; label: string };
}

/**
 * Event → resolvers → changed state attributes → materiality. Returns null for
 * Part 1 runs (no observed_event), so their graphs are built exactly as before.
 * Resolver→attribute edges carry the attribute's confidence, so the graph shows
 * which resolver established each fact and how confident it was.
 */
function buildStateResolutionPath(
  events: RunEvent[],
  addNode: (n: GraphNode) => void,
  addEdge: (e: GraphEdge) => void,
  teamVerdict: Verdict
): Part2Path | null {
  const observed = find(events, "observed_event");
  if (!observed) return null;

  const started = find(events, "state_resolution_started");
  const assembled = find(events, "state_assembled");
  const deltaEvent = find(events, "state_delta");
  const materialityEvent = find(events, "materiality");
  const emphasize = teamVerdict !== "PASS";

  // Column 0 — the observed event.
  const oc = observed.event.observed_change;
  addNode({
    id: "event",
    kind: "event",
    label: `${observed.event.event_id} · ${observed.event.event_type}`,
    sublabel: `${oc.source_system} → ${oc.destination_system} (${oc.mechanism})`,
    column: 0,
    active: true,
  });

  // Column 1 — the four resolvers, each with its status.
  const resultsById = new Map<string, Extract<RunEvent, { type: "resolver_result" }>["result"]>();
  for (const e of events) {
    if (e.type === "resolver_result") resultsById.set(e.result.resolverId, e.result);
  }
  for (const r of started?.resolvers ?? []) {
    const res = resultsById.get(r.id);
    const method = (res?.method ?? r.method) === "model" ? "model" : "lookup";
    addNode({
      id: `resolver:${r.id}`,
      kind: "resolver",
      label: r.name,
      sublabel: res ? `${res.status} · ${method}` : `running · ${method}`,
      column: 1,
      active: true,
      status: res?.status,
    });
    addEdge({ id: `e:event->resolver:${r.id}`, source: "event", target: `resolver:${r.id}` });
  }

  // State could not be established: resolvers → "state not assembled" → outcome.
  if (assembled && !assembled.ok) {
    addNode({
      id: "delta:unassembled",
      kind: "delta",
      label: `State ${assembled.status}`,
      sublabel: "stopped before routing",
      column: 2,
      active: true,
      status: assembled.status === "assembled" ? undefined : (assembled.status as ResolverStatus),
    });
    for (const [id, res] of resultsById) {
      if (res.status === "resolved") continue;
      addEdge({
        id: `e:resolver:${id}->delta:unassembled`,
        source: `resolver:${id}`,
        target: "delta:unassembled",
        label: res.status,
        verdict: teamVerdict,
        emphasized: true,
      });
    }
    return { handoffId: "delta:unassembled", bypass: { from: "delta:unassembled", label: "human review" } };
  }

  // Column 2 — changed attributes (emphasized) plus one "unchanged" summary node.
  const provenance = assembled?.provenance ?? {};
  const material = new Set(materialityEvent?.result.materialChanges ?? []);
  const entries = deltaEvent?.delta.entries ?? [];
  const first = deltaEvent?.delta.firstObservation ?? false;
  const unchanged = entries.filter((e) => !e.changed);

  for (const e of entries.filter((x) => x.changed)) {
    const id = `delta:${e.attribute}`;
    addNode({
      id,
      kind: "delta",
      label: e.attribute,
      sublabel: first ? `new: ${fmt(e.current)}` : `${fmt(e.prior)} → ${fmt(e.current)}`,
      column: 2,
      active: true,
      status: "changed",
    });
    const p = provenance[e.attribute];
    if (p) {
      addEdge({
        id: `e:resolver:${p.resolver}->${id}`,
        source: `resolver:${p.resolver}`,
        target: id,
        label: p.confidence.toFixed(2),
      });
    }
  }
  if (unchanged.length) {
    addNode({
      id: "delta:unchanged",
      kind: "delta",
      label: "Unchanged",
      sublabel: unchanged.map((e) => e.attribute).join(", "),
      column: 2,
      active: true,
      status: "unchanged",
    });
    const sources = new Set(
      unchanged.map((e) => provenance[e.attribute]?.resolver).filter(Boolean) as string[]
    );
    for (const r of sources) {
      addEdge({
        id: `e:resolver:${r}->delta:unchanged`,
        source: `resolver:${r}`,
        target: "delta:unchanged",
      });
    }
  }

  // Column 3 — the materiality filter (the hand-off into Part 1).
  if (!materialityEvent) return { handoffId: "materiality" };
  const m = materialityEvent.result;
  addNode({
    id: "materiality",
    kind: "materiality",
    label: `Material change: ${m.material ? "YES" : "NO"}`,
    sublabel: m.material
      ? `${m.materialChanges.length} material → decision rights`
      : "governance not invoked",
    column: 3,
    active: true,
    status: m.material ? "material" : "not_material",
  });
  for (const e of entries.filter((x) => x.changed)) {
    const isMaterial = material.has(e.attribute);
    addEdge({
      id: `e:delta:${e.attribute}->materiality`,
      source: `delta:${e.attribute}`,
      target: "materiality",
      label: isMaterial ? "material" : "not material",
      verdict: isMaterial && emphasize ? teamVerdict : undefined,
      emphasized: isMaterial && emphasize,
    });
  }

  return m.material
    ? { handoffId: "materiality" }
    : { handoffId: "materiality", bypass: { from: "materiality", label: "not material" } };
}

function fmt(v: unknown): string {
  if (v === undefined) return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function prettyRole(role: string): string {
  return role
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
