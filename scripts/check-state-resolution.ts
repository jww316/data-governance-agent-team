/**
 * M9 unit + pipeline checks for Part 2 state resolution. OFFLINE: no API key
 * and no audit writes. Model responses come from fixtures, and the governance
 * run and audit store are stubbed. Covers:
 *   - the four resolvers (lookup + model), fallback, unresolved, conflicted, failed
 *   - deterministic assembly, derived state, delta, materiality
 *   - the hand-off routes through the UNCHANGED matrix to the expected agents
 *   - the full pipeline: handed-off, not-material, unresolved and failed paths
 *   - the relationship graph gains the Part 2 columns
 * Run with: npm run check:state-resolution
 */
import {
  AgentResult,
  Change,
  ResolverResult,
  RunEvent,
  StateResolutionScenario,
  getAgentContract,
  loadGovernance,
  loadStateResolution,
} from "../lib/governance";
import { ModelCall, buildUserMessage } from "../lib/agents";
import { runResolver } from "../lib/resolvers";
import {
  assembleState,
  buildHandoff,
  computeDelta,
  deriveState,
  evaluateMateriality,
} from "../lib/state";
import { selectAgents } from "../lib/routing";
import { resolveStewards } from "../lib/steward";
import { runStateResolution } from "../lib/stateResolution";
import { aggregateVerdict, type RunHooks, type RunResult } from "../lib/orchestrator";
import type { AuditEntry } from "../lib/audit";
import { buildGraph } from "../lib/graph";

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`    ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const cfg = loadStateResolution();
const gov = loadGovernance();
const scenario = cfg.scenario;
const input = { event: scenario.observed_event, evidence: scenario.evidence };
const contract = (id: string) => cfg.resolversById[id];

// --- Fixture model ------------------------------------------------------------
// Answers per resolver (identified from the system prompt). `calls` records
// which resolvers actually reached the model.
function fixtureModel(
  overrides: Record<string, string | (() => string)> = {}
): ModelCall & { calls: string[] } {
  const calls: string[] = [];
  const answers: Record<string, string> = {
    purpose_resolver: JSON.stringify({
      status: "resolved",
      attributes: {
        processing_purpose: {
          value: "marketing",
          confidence: 0.96,
          evidence: [
            "integration_description",
            "destination_application_category",
            "destination_business_owner",
          ],
        },
      },
      summary:
        "Most consistent with marketing, given the campaign description, marketing-automation destination and Marketing ownership.",
    }),
    classification_resolver: JSON.stringify({
      status: "resolved",
      attributes: {
        contains_pii: { value: true, confidence: 0.95, evidence: ["field:email_address"] },
        classification: { value: "personal_data", confidence: 0.95, evidence: ["field:full_name"] },
      },
      summary: "Field names indicate direct identifiers.",
    }),
  };
  const fn = (async ({ system }) => {
    const id = /\(id: ([a-z_]+)\)/.exec(system)?.[1] ?? "unknown";
    calls.push(id);
    const o = overrides[id];
    if (o !== undefined) return typeof o === "function" ? o() : o;
    return answers[id] ?? "{}";
  }) as ModelCall & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const FIXED_NOW = () => new Date("2026-09-18T12:00:00Z");

async function main() {
  // ===========================================================================
  console.log("\n=== Resolver unit checks ===");
  const model = fixtureModel();
  const deps = { callModel: model, now: FIXED_NOW };

  const cls = await runResolver(contract("classification_resolver"), input, cfg, deps);
  console.log("  Classification Resolver");
  check(cls.status === "resolved", "status = resolved");
  check(cls.attributes.contains_pii?.value === true, "contains_pii = true");
  check(cls.attributes.classification?.value === "personal_data", "classification = personal_data");
  check(cls.method === "authoritative_lookup", "resolved by authoritative lookup (no model call)");
  check(
    eq(cls.attributes.contains_pii.evidence, [
      "catalog:CRM.customer.full_name",
      "catalog:CRM.customer.email_address",
    ]),
    "contains_pii evidence cites the two PII catalog entries"
  );

  const loc = await runResolver(contract("location_resolver"), input, cfg, deps);
  console.log("  Location Resolver");
  check(loc.status === "resolved", "status = resolved");
  check(loc.attributes.origin_location?.value === "US", "origin_location = US");
  check(loc.attributes.destination_location?.value === "Germany", "destination_location = Germany");

  const rec = await runResolver(contract("recipient_resolver"), input, cfg, deps);
  console.log("  Recipient Resolver");
  check(rec.status === "resolved", "status = resolved");
  check(rec.attributes.recipient_type?.value === "external_processor", "recipient_type = external_processor");
  check(rec.attributes.recipient_id?.value === "CampaignCloud", "recipient_id = CampaignCloud");

  const pur = await runResolver(contract("purpose_resolver"), input, cfg, deps);
  console.log("  Purpose Resolver");
  check(pur.status === "resolved", "status = resolved");
  check(pur.attributes.processing_purpose?.value === "marketing", "processing_purpose = marketing");
  check(pur.method === "model", "resolved by the model");
  check(pur.attributes.processing_purpose?.confidence === 0.96, "confidence 0.96 retained at attribute level");
  check(pur.resolvedAt === "2026-09-18T12:00:00.000Z", "resolvedAt provenance recorded");
  check(eq(model.calls, ["purpose_resolver"]), "only the Purpose resolver called the model");

  console.log("  Evidence scoping");
  const seen: string[] = [];
  const spy: ModelCall = async (req) => {
    seen.push(req.user);
    return model(req);
  };
  await runResolver(contract("purpose_resolver"), input, cfg, { callModel: spy });
  check(
    seen[0].includes("integration_description") && !seen[0].includes("catalog"),
    "Purpose resolver sees business context, but not the data catalog"
  );

  console.log("  Model fallback (catalog does not cover the fields)");
  const noCatalog = clone(input);
  noCatalog.evidence.data_evidence.catalog = {};
  const fbModel = fixtureModel();
  const fb = await runResolver(contract("classification_resolver"), noCatalog, cfg, { callModel: fbModel });
  check(eq(fbModel.calls, ["classification_resolver"]), "falls back to the model");
  check(fb.status === "resolved" && fb.method === "model", "resolved by the model, labelled as such");

  console.log("  Unresolved: confidence below threshold");
  const lowConf = await runResolver(contract("purpose_resolver"), input, cfg, {
    callModel: fixtureModel({
      purpose_resolver: JSON.stringify({
        status: "resolved",
        attributes: { processing_purpose: { value: "marketing", confidence: 0.6, evidence: ["x"] } },
        summary: "weak",
      }),
    }),
  });
  check(lowConf.status === "unresolved", "0.60 < 0.90 → unresolved");

  console.log("  Unresolved: value outside the taxonomy");
  const badValue = await runResolver(contract("purpose_resolver"), input, cfg, {
    callModel: fixtureModel({
      purpose_resolver: JSON.stringify({
        status: "resolved",
        attributes: { processing_purpose: { value: "sales_outreach", confidence: 0.99, evidence: ["x"] } },
        summary: "?",
      }),
    }),
  });
  check(badValue.status === "unresolved", "non-taxonomy purpose → unresolved");

  console.log("  Conflicted: catalog vs content inspection");
  const conflict = clone(input);
  conflict.evidence.data_evidence.content_inspection = {
    "CRM.customer.customer_id": { detected: "PII" },
  };
  const conf = await runResolver(contract("classification_resolver"), conflict, cfg, deps);
  check(conf.status === "conflicted", "status = conflicted");
  check(
    eq(conf.conflicts?.[0]?.evidence, [
      "catalog:CRM.customer.customer_id",
      "content_inspection:CRM.customer.customer_id",
    ]),
    "both evidence references preserved"
  );

  console.log("  Failed: unparseable model output after retry");
  const broken = fixtureModel({ purpose_resolver: "not json" });
  const failed = await runResolver(contract("purpose_resolver"), input, cfg, { callModel: broken });
  check(failed.status === "failed", "status = failed");
  check(broken.calls.length === 2, "retried once");
  check(Object.keys(failed.attributes).length === 0, "no state fabricated");

  // ===========================================================================
  console.log("\n=== State assembler / derived state ===");
  const results: ResolverResult[] = [cls, loc, rec, pur];
  const assembly = assembleState(results, cfg.assembly);
  const prior = scenario.prior_state!.attributes;
  check(assembly.ok && assembly.status === "assembled", "assembled");
  check(
    eq(assembly.routingState, {
      contains_pii: true,
      classification: "personal_data",
      origin_location: "US",
      destination_location: "Germany",
      recipient_type: "external_processor",
      processing_purpose: "marketing",
    }),
    "routing state matches §18.2"
  );
  check(assembly.provenance.processing_purpose?.resolver === "purpose_resolver", "provenance names the resolver");
  const derived = deriveState(assembly.routingState, prior, cfg.assembly);
  check(derived.cross_border === true, "cross_border = true");
  check(derived.external_transfer === true, "external_transfer = true");
  check(derived.purpose_change === true, "purpose_change = true");

  const notAssembled = assembleState([cls, loc, rec, lowConf], cfg.assembly);
  check(!notAssembled.ok && notAssembled.status === "unresolved", "an unresolved resolver stops assembly");
  const conflicted = assembleState([conf, loc, rec, pur], cfg.assembly);
  check(conflicted.status === "conflicted", "a conflicted resolver stops assembly as conflicted");

  // ===========================================================================
  console.log("\n=== State delta ===");
  const delta = computeDelta(prior, assembly.routingState);
  const changed = delta.entries.filter((e) => e.changed).map((e) => e.attribute).sort();
  check(
    eq(changed, ["destination_location", "processing_purpose", "recipient_type"]),
    `changed = destination_location, processing_purpose, recipient_type (got ${changed.join(", ")})`
  );
  check(
    delta.entries.some((e) => e.attribute === "contains_pii" && !e.changed),
    "unchanged attributes retained (contains_pii unchanged)"
  );

  // ===========================================================================
  console.log("\n=== Materiality ===");
  const mat = evaluateMateriality(delta, cfg.materiality);
  check(mat.material === true, "governance_material_change = true");
  check(eq([...mat.materialChanges].sort(), changed), "all three changes are material");

  const techOnly = evaluateMateriality(
    computeDelta(
      { ...assembly.routingState, physical_server: "crm-db-01" },
      { ...assembly.routingState, physical_server: "crm-db-07" }
    ),
    cfg.materiality
  );
  check(techOnly.material === false, "physical_server-only change → governance_material_change = false");
  check(eq(techOnly.nonMaterialChanges, ["physical_server"]), "physical_server logged as non-material");

  const unknownAttr = evaluateMateriality(
    computeDelta({ retention_tier: "a" }, { retention_tier: "b" }),
    cfg.materiality
  );
  check(unknownAttr.material === true, "an attribute with no rule is material (fail-safe)");

  const firstObs = computeDelta(null, assembly.routingState);
  const firstMat = evaluateMateriality(firstObs, cfg.materiality);
  check(firstObs.firstObservation && firstMat.material, "missing prior state → first observation, material");
  check(deriveState(assembly.routingState, null, cfg.assembly).purpose_change === false, "no prior → purpose_change = false");

  // ===========================================================================
  console.log("\n=== Hand-off to the existing control plane ===");
  const handoff = buildHandoff(scenario, assembly.routingState, derived, mat);
  const routing = selectAgents(handoff.change);
  check(
    eq(routing.agentIds, ["classification_pii", "policy_jurisdiction", "assignment_steward"]),
    `existing matrix routes to Classification + Policy (+ Assignment last) (got ${routing.agentIds.join(", ")})`
  );
  check(!routing.agentIds.includes("relationship_lineage"), "Relationship & Lineage not forced in (no foreign key)");
  const stewards = resolveStewards(handoff.change, true);
  check(stewards.byDimension.compliance?.privacy_steward === "Dana Okoro", "Privacy Steward = Dana Okoro");
  check(stewards.byDimension.compliance?.data_protection_officer === "Jan Walker", "DPO = Jan Walker");
  check(eq(stewards.crossBorder, ["Dana Okoro", "Jan Walker"]), "cross-border review applies");
  check(handoff.input.material_change === true, "compact hand-off input carries material_change");

  const policyMsg = buildUserMessage(getAgentContract("policy_jurisdiction"), handoff.change);
  const classMsg = buildUserMessage(getAgentContract("classification_pii"), handoff.change);
  check(policyMsg.includes("DECISION EVIDENCE"), "Policy agent receives decision evidence (contract permits it)");
  check(!classMsg.includes("DECISION EVIDENCE"), "Classification agent does not (its contract does not)");
  const monitorMsg = buildUserMessage(getAgentContract("policy_jurisdiction"), {
    source: "monitor",
    asset: { scenarioId: "x", domain: "Customer" },
    state_attributes: {},
    declared: {},
  });
  check(
    !monitorMsg.includes("DECISION EVIDENCE") && !monitorMsg.includes("STATE RESOLUTION"),
    "Part 1 prompts unchanged"
  );

  // ===========================================================================
  console.log("\n=== Pipeline: handed off → ESCALATE (stubbed agent team) ===");
  const p = await runPipeline(scenario, fixtureModel());
  check(p.run.outcome === "handed_off", "outcome = handed_off");
  check(p.govCalls === 1, "the existing governance run was invoked once");
  check(p.run.teamVerdict === "ESCALATE", "team verdict = ESCALATE (from the stubbed agents)");
  const order = [
    "observed_event",
    "state_resolution_started",
    "resolver_started",
    "resolver_result",
    "state_assembled",
    "state_delta",
    "materiality",
    "state_resolution_complete",
    "governance_handoff",
    "routing",
    "team_verdict",
  ];
  const types = p.events.map((e) => e.type);
  let cursor = -1;
  const inOrder = order.every((t) => {
    const i = types.indexOf(t as RunEvent["type"], cursor + 1);
    if (i === -1) return false;
    cursor = i;
    return true;
  });
  check(inOrder, "stages emitted in order: event → resolvers → state → delta → materiality → hand-off → routing → verdict");
  check(types.filter((t) => t === "resolver_result").length === 4, "four independent resolver results");
  check(
    p.upstream?.stateResolution.outcome === "handed_off" &&
      p.upstream.stateResolution.events.length > 0,
    "Part 2 stage events passed to the audit entry"
  );

  const graph = buildGraph({
    events: p.events,
    roster: gov.agents.map((a) => ({ id: a.id, name: a.name })),
  });
  const kinds = (k: string) => graph.nodes.filter((n) => n.kind === k);
  check(kinds("event").length === 1, "graph: event node");
  check(kinds("resolver").length === 4, "graph: four resolver nodes");
  check(
    eq(
      kinds("delta").filter((n) => n.status === "changed").map((n) => n.label).sort(),
      changed
    ),
    "graph: the three changed attributes"
  );
  check(kinds("materiality").length === 1, "graph: materiality node");
  check(!graph.nodes.some((n) => n.id === "origin"), "graph: materiality replaces the Part 1 origin");
  check(
    graph.edges.some((e) => e.source === "materiality" && e.target.startsWith("state:")),
    "graph: materiality hands off into the matrix's routing state"
  );
  check(
    graph.edges.some((e) => e.source === "resolver:purpose_resolver" && e.label === "0.96"),
    "graph: resolver → attribute edge labelled with confidence"
  );
  check(graph.nodes.find((n) => n.kind === "outcome")?.verdict === "ESCALATE", "graph: outcome ESCALATE");

  const part1Graph = buildGraph({
    events: [
      { type: "run_started", change: { summary: "x", source: "monitor" } },
      { type: "routing", agentsSelected: ["quality", "assignment_steward"], matchedRules: [] },
      { type: "team_verdict", verdict: "PASS" },
    ],
    roster: gov.agents.map((a) => ({ id: a.id, name: a.name })),
  });
  check(
    part1Graph.nodes.some((n) => n.id === "origin" && n.column === 0) &&
      !part1Graph.nodes.some((n) => n.kind === "resolver"),
    "graph: Part 1 runs are built as before (origin in column 0, no Part 2 nodes)"
  );

  // ===========================================================================
  console.log("\n=== Pipeline: not material (prior state already matches) ===");
  const same = clone(scenario);
  same.prior_state!.attributes = { ...assembly.routingState };
  const nm = await runPipeline(same, fixtureModel());
  check(nm.run.outcome === "not_material", "outcome = not_material");
  check(nm.govCalls === 0, "governance agent team NOT invoked");
  check(nm.audits[0]?.teamVerdict === "PASS" && nm.audits[0]?.agentResults.length === 0, "logged as PASS with no agents");
  check(nm.audits[0]?.stateResolution?.outcome === "not_material", "audit records the not-material outcome");

  console.log("\n=== Pipeline: unresolved purpose → stop before routing ===");
  const un = await runPipeline(
    scenario,
    fixtureModel({
      purpose_resolver: JSON.stringify({
        status: "unresolved",
        attributes: {},
        summary: "Evidence insufficient.",
      }),
    })
  );
  check(un.run.outcome === "unresolved", "outcome = unresolved");
  check(un.govCalls === 0, "governance routing NOT reached");
  check(un.run.teamVerdict === "ESCALATE", "state-resolution escalation");
  check(
    un.audits[0]?.stewards?.humanReview?.steward === gov.matrix.steward_resolution.governance_lead,
    "routed to the matrix's governance lead for human review"
  );
  check(!un.events.some((e) => e.type === "state_delta"), "no delta computed from unknown state");

  console.log("\n=== Pipeline: resolver technical failure ===");
  const fl = await runPipeline(
    scenario,
    fixtureModel({
      purpose_resolver: () => {
        throw new Error("network down");
      },
    })
  );
  check(fl.run.outcome === "failed", "outcome = failed");
  check(fl.govCalls === 0, "governance routing NOT reached");

  if (failures > 0) {
    console.error(`\n✗ M9 offline checks FAILED (${failures} assertion(s)).`);
    process.exit(1);
  }
  console.log("\n✓ M9 offline checks passed: resolvers, assembler, delta, materiality, hand-off, pipeline paths, graph.");
}

/** Run the pipeline with a stubbed agent team and audit store. */
async function runPipeline(sc: StateResolutionScenario, callModel: ModelCall) {
  const events: RunEvent[] = [];
  const audits: AuditEntry[] = [];
  let govCalls = 0;
  let upstream: RunHooks["upstream"];

  const run = await runStateResolution(sc, (e) => void events.push(e), {
    callModel,
    now: FIXED_NOW,
    appendAudit: (entry) => {
      const full = { ...entry, id: `aud_test_${audits.length}`, timestamp: FIXED_NOW().toISOString() };
      audits.push(full);
      return full;
    },
    // Stands in for the real agent team: real routing + steward resolution
    // with canned verdicts. The live check (check:part2) uses real agents.
    runGovernance: async (change: Change, emit, hooks = {}): Promise<RunResult> => {
      govCalls++;
      upstream = hooks.upstream;
      const routing = selectAgents(change);
      await emit({ type: "run_started", change: { summary: "stub", source: change.source } });
      await emit({
        type: "routing",
        agentsSelected: routing.agentIds,
        matchedRules: routing.matchedRules.map((r) => ({ when: r.when, invoke: r.invoke })),
      });
      const agentResults: AgentResult[] = routing.agentIds.map((id) => ({
        agentId: id,
        agentName: gov.agentsById[id].name,
        verdict: id === "classification_pii" ? "PASS" : "ESCALATE",
        reasoning: "stub",
        details: {},
      }));
      for (const r of agentResults) {
        await emit({ type: "agent_result", ...r });
      }
      const assignment = resolveStewards(change, true);
      const teamVerdict = aggregateVerdict(agentResults);
      await emit({ type: "assignment", assignment });
      await emit({ type: "team_verdict", verdict: teamVerdict });
      return { teamVerdict, agentResults, assignment, auditId: "aud_stub" };
    },
  });
  return { run, events, audits, govCalls, upstream };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
