/**
 * M8 acceptance: each of the three monitor scenarios produces a relationship
 * graph (persisted on its audit entry) whose path matches that run's events —
 * invoked agents colored by verdict, un-invoked agents grayed, state→agent edges
 * labeled with the matched matrix rule, and stewards on ESCALATE.
 * Run with: npm run check:graph   (requires ANTHROPIC_API_KEY)
 */
import "./_env";
import { loadGovernance } from "../lib/governance";
import { buildMonitorChange } from "../lib/adapters";
import { runGovernance } from "../lib/orchestrator";
import { readAudit } from "../lib/audit";
import type { GovGraph } from "../lib/graph";

interface Expect {
  verdict: "PASS" | "BLOCK" | "ESCALATE";
  invoked: string[];
  grayed: string[];
  requirePolicy?: string;
  requireStewards?: string[];
}

const EXPECT: Record<string, Expect> = {
  public_reference_clean: {
    verdict: "PASS",
    invoked: ["quality", "assignment_steward"],
    grayed: ["classification_pii", "policy_jurisdiction", "relationship_lineage"],
  },
  support_export_hidden_pii: {
    verdict: "BLOCK",
    invoked: ["classification_pii", "policy_jurisdiction", "assignment_steward"],
    grayed: ["quality", "relationship_lineage"],
    requirePolicy: "pii_protection",
  },
  eu_marketing_no_consent: {
    verdict: "ESCALATE",
    invoked: ["classification_pii", "policy_jurisdiction", "assignment_steward"],
    grayed: ["quality", "relationship_lineage"],
    requirePolicy: "cross_border",
    requireStewards: ["Dana Okoro", "Jan Walker"],
  },
};

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`    ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
}

function agentId(nodeId: string): string {
  return nodeId.replace(/^agent:/, "");
}

function assertGraph(scenarioId: string, graph: GovGraph, exp: Expect) {
  const agents = graph.nodes.filter((n) => n.kind === "agent");
  const invoked = agents.filter((n) => n.active).map((n) => agentId(n.id)).sort();
  const grayed = agents.filter((n) => !n.active).map((n) => agentId(n.id)).sort();

  check(agents.length === 5, "all 5 agents present in the roster");
  check(
    JSON.stringify(invoked) === JSON.stringify([...exp.invoked].sort()),
    `invoked agents = [${exp.invoked.sort().join(", ")}] (got [${invoked.join(", ")}])`
  );
  check(
    JSON.stringify(grayed) === JSON.stringify([...exp.grayed].sort()),
    `un-invoked (grayed) agents = [${exp.grayed.sort().join(", ")}]`
  );

  // Invoked agents colored by a verdict; grayed agents have no verdict + no edges.
  const invokedColored = agents
    .filter((n) => n.active)
    .every((n) => n.verdict !== undefined);
  check(invokedColored, "every invoked agent node carries a verdict color");
  const grayedNoEdges = agents
    .filter((n) => !n.active)
    .every((n) => !graph.edges.some((e) => e.source === n.id));
  check(grayedNoEdges, "grayed agents have no outgoing edges");

  // State→agent edges labeled with the matched matrix rule.
  const labeled = graph.edges.filter((e) => e.label?.startsWith("matched:"));
  check(labeled.length > 0, `state→agent edges labeled with matched rule (${labeled.length})`);

  // Outcome node + verdict.
  const outcome = graph.nodes.find((n) => n.kind === "outcome");
  check(outcome?.verdict === exp.verdict, `outcome verdict = ${exp.verdict}`);

  // Emphasized path on non-PASS verdicts.
  if (exp.verdict !== "PASS") {
    check(
      graph.edges.some((e) => e.emphasized && e.verdict === exp.verdict),
      "blocking/escalating path is emphasized"
    );
  }

  // Scenario-specific policy node on the path.
  if (exp.requirePolicy) {
    const pol = graph.nodes.find(
      (n) => n.kind === "policy" && n.label === exp.requirePolicy
    );
    check(Boolean(pol), `policy node "${exp.requirePolicy}" present on the path`);
    if (pol) {
      check(
        graph.edges.some((e) => e.source === pol.id && e.target === "outcome"),
        `"${exp.requirePolicy}" → outcome edge present`
      );
    }
  }

  // Stewards on ESCALATE.
  if (exp.requireStewards) {
    const stewards = graph.nodes
      .filter((n) => n.kind === "steward")
      .map((n) => n.label);
    for (const s of exp.requireStewards) {
      check(stewards.includes(s), `steward node "${s}" present`);
    }
  }
}

async function main() {
  const gov = loadGovernance();

  for (const scenario of gov.scenarios) {
    const exp = EXPECT[scenario.id];
    console.log(`\n=== ${scenario.id} (expect ${exp.verdict}) ===`);
    const { change } = buildMonitorChange(scenario, "json", 6);
    const result = await runGovernance(change, () => {});

    // Read the graph back from the persisted audit entry (tests persistence).
    const entry = readAudit().find((e) => e.id === result.auditId);
    if (!entry || !entry.graph) {
      console.log("    ✗ no graph persisted on the audit entry");
      failures++;
      continue;
    }
    assertGraph(scenario.id, entry.graph, exp);
  }

  if (failures > 0) {
    console.error(`\n✗ M8 acceptance FAILED (${failures} assertion(s)).`);
    process.exit(1);
  }
  console.log(
    "\n✓ M8 acceptance passed — graphs match events; routing visible; stewards on escalate; persisted for replay."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
