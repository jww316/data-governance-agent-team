/**
 * orchestrator.ts — the feature-agnostic engine (IMPLEMENTATION.md §7).
 *
 * Given a Change it: routes (deterministic), runs the selected agents in
 * parallel, runs the assignment agent after (it consumes the others' verdicts),
 * aggregates the team verdict, resolves stewards, optionally runs a GitHub step
 * (Feature 1), writes the audit entry, and emits RunEvents throughout.
 */

import {
  AgentResult,
  Change,
  RunEvent,
  StewardAssignment,
  Verdict,
  loadGovernance,
} from "./governance";
import { selectAgents } from "./routing";
import { runAgent } from "./agents";
import { resolveStewards } from "./steward";
import { appendAudit } from "./audit";

export type Emit = (event: RunEvent) => void | Promise<void>;

export interface GithubOutcome {
  prUrl?: string;
  prState?: string;
  skipped?: boolean;
  message?: string;
}

export interface RunHooks {
  /**
   * Feature 1 only: open/annotate the real PR. Called after the team verdict is
   * known and before the audit is written, so the audit captures the PR result.
   */
  onGithub?: (ctx: {
    change: Change;
    teamVerdict: Verdict;
    agentResults: AgentResult[];
    assignment: StewardAssignment;
  }) => Promise<GithubOutcome>;
}

export interface RunResult {
  teamVerdict: Verdict;
  agentResults: AgentResult[];
  assignment: StewardAssignment;
  auditId: string;
  github?: GithubOutcome;
}

const ASSIGNMENT = "assignment_steward";

/** any BLOCK -> BLOCK; else any ESCALATE -> ESCALATE; else PASS (§7). */
export function aggregateVerdict(results: AgentResult[]): Verdict {
  if (results.some((r) => r.verdict === "BLOCK")) return "BLOCK";
  if (results.some((r) => r.verdict === "ESCALATE")) return "ESCALATE";
  return "PASS";
}

function summarize(change: Change): string {
  if (change.source === "gate" && change.diff) {
    const parts: string[] = [];
    if (change.diff.added.length)
      parts.push(`+${change.diff.added.map((c) => c.name).join(", ")}`);
    if (change.diff.altered.length)
      parts.push(`~${change.diff.altered.map((c) => c.name).join(", ")}`);
    if (change.diff.removed.length)
      parts.push(`-${change.diff.removed.map((c) => c.name).join(", ")}`);
    return `Gate: ${change.asset.table} (${parts.join("; ") || "no-op"})`;
  }
  return `Monitor: ${change.asset.scenarioId} landing (${
    change.records?.length ?? 0
  } records)`;
}

/**
 * Run the full governance evaluation for one change, streaming events via `emit`.
 */
export async function runGovernance(
  change: Change,
  emit: Emit,
  hooks: RunHooks = {}
): Promise<RunResult> {
  const gov = loadGovernance();

  await emit({
    type: "run_started",
    change: { summary: summarize(change), source: change.source },
  });

  // --- Routing (deterministic, matrix-driven) -------------------------------
  const routing = selectAgents(change);
  await emit({
    type: "routing",
    agentsSelected: routing.agentIds,
    matchedRules: routing.matchedRules.map((r) => ({
      when: r.when,
      invoke: r.invoke,
    })),
  });

  const blockingIds = routing.agentIds.filter((id) => id !== ASSIGNMENT);

  // --- Run independent agents in parallel -----------------------------------
  for (const id of blockingIds) {
    const c = gov.agentsById[id];
    await emit({
      type: "agent_started",
      agentId: id,
      agentName: c.name,
      one_liner: c.one_liner,
    });
  }

  const agentResults = await Promise.all(
    blockingIds.map(async (id) => {
      const contract = gov.agentsById[id];
      const result = await runAgent(contract, change);
      await emit({
        type: "agent_result",
        agentId: result.agentId,
        agentName: result.agentName,
        verdict: result.verdict,
        reasoning: result.reasoning,
        details: result.details,
      });
      return result;
    })
  );

  // --- Deterministic steward resolution -------------------------------------
  // A human owner is required only if some blocking agent escalated or blocked.
  // (Cross-border consumption alone is not enough — an approved cross-border asset
  // edited benignly is still routine. The cross-border *review* steward is added
  // by resolveStewards when relevant; it does not by itself force an owner.)
  const ownerRequired = agentResults.some(
    (r) => r.verdict === "BLOCK" || r.verdict === "ESCALATE"
  );
  const assignment = resolveStewards(change, ownerRequired);

  // --- Assignment agent runs last (consumes the others' results) ------------
  let assignmentResult: AgentResult | null = null;
  if (routing.agentIds.includes(ASSIGNMENT)) {
    const contract = gov.agentsById[ASSIGNMENT];
    await emit({
      type: "agent_started",
      agentId: ASSIGNMENT,
      agentName: contract.name,
      one_liner: contract.one_liner,
    });
    assignmentResult = await runAgent(contract, change, {
      priorResults: agentResults,
      stewardResolution: assignment,
      ownerRequired,
    });
    assignmentResult.stewardsAssigned = assignment;
    await emit({
      type: "agent_result",
      agentId: assignmentResult.agentId,
      agentName: assignmentResult.agentName,
      verdict: assignmentResult.verdict,
      reasoning: assignmentResult.reasoning,
      details: assignmentResult.details,
    });
  }

  const allResults = assignmentResult
    ? [...agentResults, assignmentResult]
    : agentResults;

  // --- Aggregate team verdict -----------------------------------------------
  const teamVerdict = aggregateVerdict(allResults);

  await emit({ type: "assignment", assignment });
  await emit({ type: "team_verdict", verdict: teamVerdict });

  // --- GitHub step (Feature 1 only) -----------------------------------------
  let github: GithubOutcome | undefined;
  if (hooks.onGithub) {
    github = await hooks.onGithub({
      change,
      teamVerdict,
      agentResults: allResults,
      assignment,
    });
    await emit({ type: "github", ...github });
  }

  // --- Audit ----------------------------------------------------------------
  const auditEntry = appendAudit({
    source: change.source,
    asset: change.asset,
    summary: summarize(change),
    agentResults: allResults,
    teamVerdict,
    stewards: assignment,
    github,
  });
  await emit({ type: "audit_written", auditId: auditEntry.id });
  await emit({ type: "run_complete", verdict: teamVerdict });

  return {
    teamVerdict,
    agentResults: allResults,
    assignment,
    auditId: auditEntry.id,
    github,
  };
}
