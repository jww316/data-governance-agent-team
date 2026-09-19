/**
 * stateResolution.ts — the Part 2 upstream pipeline.
 *
 *   observed event → evidence → 4 resolvers (parallel) → assembler → delta
 *     → materiality → hand-off → the EXISTING runGovernance() (unchanged)
 *
 * It emits a RunEvent for every stage, so the live log, the relationship graph
 * and the audit replay all show the full chain. It stops safely before
 * governance routing when state cannot be established, and it skips the agent
 * team when nothing governance-relevant changed.
 */

import {
  ResolverResult,
  RunEvent,
  StateResolutionOutcome,
  StateResolutionScenario,
  StewardAssignment,
  Verdict,
  loadGovernance,
  loadStateResolution,
} from "./governance";
import { ModelCall, callModel as defaultCallModel } from "./agents";
import { runResolvers } from "./resolvers";
import {
  AssemblyResult,
  Handoff,
  assembleState,
  buildHandoff,
  computeDelta,
  deriveState,
  evaluateMateriality,
} from "./state";
import { Emit, RunResult, runGovernance as defaultRunGovernance } from "./orchestrator";
import { appendAudit as defaultAppendAudit } from "./audit";
import { buildGraph } from "./graph";

/** Injectable collaborators, so offline checks run with no API key or audit writes. */
export interface StateResolutionDeps {
  callModel?: ModelCall;
  runGovernance?: typeof defaultRunGovernance;
  appendAudit?: typeof defaultAppendAudit;
  now?: () => Date;
}

export interface StateResolutionRun {
  outcome: StateResolutionOutcome;
  teamVerdict: Verdict;
  auditId?: string;
  resolverResults: ResolverResult[];
  assembly: AssemblyResult;
  handoff?: Handoff;
  governance?: RunResult;
}

export async function runStateResolution(
  scenario: StateResolutionScenario,
  rawEmit: Emit,
  deps: StateResolutionDeps = {}
): Promise<StateResolutionRun> {
  const cfg = loadStateResolution();
  const gov = loadGovernance();
  const callModel = deps.callModel ?? defaultCallModel;
  const runGovernance = deps.runGovernance ?? defaultRunGovernance;
  const appendAudit = deps.appendAudit ?? defaultAppendAudit;

  // Every Part 2 stage event is kept, for the graph and the audit replay.
  const events: RunEvent[] = [];
  const emit: Emit = async (event) => {
    events.push(event);
    await rawEmit(event);
  };

  // --- 1. Change awareness: the observed event + its evidence ---------------
  await emit({
    type: "observed_event",
    scenarioId: scenario.id,
    label: scenario.label,
    event: scenario.observed_event,
    evidence: scenario.evidence,
  });

  // --- 2. Four specialized resolvers, in parallel ---------------------------
  await emit({
    type: "state_resolution_started",
    resolvers: cfg.resolvers.map((r) => ({ id: r.id, name: r.name, method: r.method })),
  });
  for (const r of cfg.resolvers) {
    await emit({
      type: "resolver_started",
      resolverId: r.id,
      resolverName: r.name,
      method: r.method,
      question: r.question,
    });
  }
  const resolverResults = await runResolvers(
    cfg.resolvers,
    { event: scenario.observed_event, evidence: scenario.evidence },
    cfg,
    { callModel, now: deps.now },
    (result) => emit({ type: "resolver_result", result })
  );

  // --- 3. Deterministic assembly (validate, normalize, derive) --------------
  const prior = scenario.prior_state?.attributes ?? null;
  const assembly = assembleState(resolverResults, cfg.assembly);
  const derived = assembly.ok
    ? deriveState(assembly.routingState, prior, cfg.assembly)
    : undefined;
  await emit({
    type: "state_assembled",
    ok: assembly.ok,
    status: assembly.status,
    problems: assembly.problems,
    routingState: assembly.routingState,
    derivedState: derived,
    provenance: assembly.provenance,
  });

  // Shared finish for the paths that never reach the agent team.
  const finishWithoutGovernance = async (
    outcome: StateResolutionOutcome,
    teamVerdict: Verdict,
    summary: string,
    assignment?: StewardAssignment
  ): Promise<string> => {
    const stageEvents = [...events];
    if (assignment) await emit({ type: "assignment", assignment });
    await emit({ type: "team_verdict", verdict: teamVerdict });
    const roster = gov.agents.map((a) => ({ id: a.id, name: a.name }));
    const entry = appendAudit({
      source: "state_resolution",
      asset: { scenarioId: scenario.id, domain: scenario.asset.domain },
      summary,
      agentResults: [],
      teamVerdict,
      stewards: assignment,
      graph: buildGraph({ events, roster }),
      stateResolution: { outcome, events: stageEvents },
    });
    await emit({ type: "audit_written", auditId: entry.id });
    await emit({ type: "run_complete", verdict: teamVerdict });
    return entry.id;
  };

  // Stop before routing if state cannot be established (§18.1, §30).
  if (!assembly.ok) {
    const outcome = assembly.status as Exclude<StateResolutionOutcome, "handed_off" | "not_material">;
    const reviewer = gov.matrix.steward_resolution.governance_lead;
    await emit({
      type: "state_resolution_complete",
      outcome,
      message: `State is ${outcome}. Stopped before governance routing, and nothing was assumed. Routed to ${reviewer} for human review.`,
    });
    const auditId = await finishWithoutGovernance(
      outcome,
      "ESCALATE",
      `State resolution: ${scenario.label} (state ${outcome}, human review)`,
      {
        byDimension: {},
        humanReview: { steward: reviewer, reason: assembly.problems.join("; ") },
      }
    );
    return { outcome, teamVerdict: "ESCALATE", auditId, resolverResults, assembly };
  }

  // --- 4. Compare prior vs. current → delta ---------------------------------
  const delta = computeDelta(prior, assembly.routingState);
  await emit({
    type: "state_delta",
    delta,
    priorRecordedAt: scenario.prior_state?.recorded_at,
  });

  // --- 5. Materiality (configuration-driven, deterministic) -----------------
  const materiality = evaluateMateriality(delta, cfg.materiality);
  await emit({ type: "materiality", result: materiality });

  if (!materiality.material) {
    await emit({
      type: "state_resolution_complete",
      outcome: "not_material",
      message:
        "No governance-relevant change. The change is logged, and the governance agent team is not invoked.",
    });
    const auditId = await finishWithoutGovernance(
      "not_material",
      "PASS",
      `State resolution: ${scenario.label} (not material, governance not invoked)`
    );
    return { outcome: "not_material", teamVerdict: "PASS", auditId, resolverResults, assembly };
  }

  // --- 6. Hand-off to the existing Part 1 control plane ---------------------
  const handoff = buildHandoff(scenario, assembly.routingState, derived!, materiality);
  await emit({
    type: "state_resolution_complete",
    outcome: "handed_off",
    message: `${materiality.materialChanges.length} material change(s): ${materiality.materialChanges.join(", ")}. Handing off to the decision-rights matrix.`,
  });
  await emit({ type: "governance_handoff", input: handoff.input });

  const stageEvents = [...events];
  const governance = await runGovernance(handoff.change, rawEmit, {
    upstream: {
      events: stageEvents,
      summary: `State resolution: ${scenario.label} (${materiality.materialChanges.length} material changes → governance)`,
      stateResolution: { outcome: "handed_off", events: stageEvents },
    },
  });

  return {
    outcome: "handed_off",
    teamVerdict: governance.teamVerdict,
    auditId: governance.auditId,
    resolverResults,
    assembly,
    handoff,
    governance,
  };
}
