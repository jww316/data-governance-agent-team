/**
 * M9 acceptance (integration): the CRM → CampaignCloud scenario, end to end,
 * with REAL model calls: the Purpose resolver plus the governance agents.
 *
 *   observed event → four resolvers → resolved state → state delta
 *     → materiality true → existing decision-rights routing → ESCALATE
 *     → Privacy Steward + DPO, persisted with the full graph for replay
 *
 * Run with: npm run check:part2   (requires ANTHROPIC_API_KEY)
 */
import "./_env";
import { RunEvent, loadStateResolution } from "../lib/governance";
import { runStateResolution } from "../lib/stateResolution";
import { readAudit } from "../lib/audit";

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`    ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
}

async function main() {
  const { scenario } = loadStateResolution();
  console.log(`\n=== ${scenario.id} (expect ${scenario.expected_verdict}) ===`);

  const events: RunEvent[] = [];
  const run = await runStateResolution(scenario, (e) => {
    events.push(e);
    if (e.type === "resolver_result") {
      const attrs = Object.entries(e.result.attributes)
        .map(([k, a]) => `${k}=${JSON.stringify(a.value)} (${a.confidence})`)
        .join(", ");
      console.log(`    [${e.result.status.padEnd(10)}] ${e.result.resolverName} (${e.result.method}): ${attrs}`);
    }
    if (e.type === "agent_result") {
      console.log(`    [${e.verdict.padEnd(10)}] ${e.agentName}: ${e.reasoning}`);
    }
  });

  console.log("\n  Stages");
  const results = run.resolverResults;
  check(results.length === 4 && results.every((r) => r.status === "resolved"), "four resolvers, all resolved");
  const purpose = results.find((r) => r.resolverId === "purpose_resolver");
  check(purpose?.attributes.processing_purpose?.value === "marketing", "Purpose resolver (model) → marketing");
  const delta = events.find((e) => e.type === "state_delta");
  const changed =
    delta?.type === "state_delta"
      ? delta.delta.entries.filter((x) => x.changed).map((x) => x.attribute).sort()
      : [];
  check(
    JSON.stringify(changed) ===
      JSON.stringify(["destination_location", "processing_purpose", "recipient_type"]),
    "delta: destination_location, recipient_type, processing_purpose changed"
  );
  const mat = events.find((e) => e.type === "materiality");
  check(mat?.type === "materiality" && mat.result.material, "materiality: governance material change = true");
  check(run.outcome === "handed_off", "handed off to the existing control plane");

  console.log("\n  Governance (existing Part 1 control plane)");
  const routing = events.find((e) => e.type === "routing");
  check(
    routing?.type === "routing" &&
      JSON.stringify(routing.agentsSelected) ===
        JSON.stringify(["classification_pii", "policy_jurisdiction", "assignment_steward"]),
    "matrix routed to Classification & PII + Policy & Jurisdiction (+ Assignment)"
  );
  check(run.teamVerdict === "ESCALATE", `team verdict = ESCALATE (got ${run.teamVerdict})`);
  const a = run.governance?.assignment;
  check(a?.byDimension.compliance?.privacy_steward === "Dana Okoro", "escalation owner: Privacy Steward Dana Okoro");
  check(a?.byDimension.compliance?.data_protection_officer === "Jan Walker", "escalation owner: DPO Jan Walker");

  console.log("\n  Audit / replay");
  const entry = readAudit().find((e) => e.id === run.auditId);
  check(Boolean(entry), `audit entry written (${run.auditId})`);
  check(entry?.stateResolution?.outcome === "handed_off", "audit entry carries the state-resolution stages");
  const kinds = new Set(entry?.graph?.nodes.map((n) => n.kind));
  check(
    ["event", "resolver", "delta", "materiality", "state", "agent", "outcome", "steward"].every((k) =>
      kinds.has(k as never)
    ),
    "saved graph spans event → resolvers → delta → materiality → routing → agents → outcome → steward"
  );

  if (failures > 0) {
    console.error(`\n✗ M9 acceptance FAILED (${failures} assertion(s)).`);
    process.exit(1);
  }
  console.log("\n✓ M9 acceptance passed: CRM → CampaignCloud resolves, hands off, and ESCALATES to the Privacy Steward + DPO.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
