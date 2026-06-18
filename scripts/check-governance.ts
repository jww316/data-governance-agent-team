/**
 * M1 acceptance: print the five contracts, policies, matrix, scenarios, schema —
 * proving they parse correctly. Run with: npm run check:governance
 */
import { loadGovernance } from "../lib/governance";

function main() {
  const gov = loadGovernance();

  console.log("=== SCHEMA ===");
  for (const [name, table] of Object.entries(gov.schema.tables)) {
    console.log(
      `  table ${name}: domain=${table.state_attributes.domain}, ` +
        `contains_pii=${table.state_attributes.contains_pii}, ` +
        `${table.columns.length} columns`
    );
  }

  console.log("\n=== AGENT CONTRACTS (5) ===");
  for (const a of gov.agents) {
    console.log(
      `  ${a.id} [${a.role_type}] verdicts=${a.verdicts.join("/")} — ${a.one_liner}`
    );
  }

  console.log("\n=== POLICIES ===");
  console.log("  " + Object.keys(gov.policies).join(", "));

  console.log("\n=== DECISION-RIGHTS MATRIX ===");
  console.log(`  routing rules: ${gov.matrix.agent_routing.length}`);
  for (const r of gov.matrix.agent_routing) {
    console.log(
      `    when ${JSON.stringify(r.when)} -> invoke ${r.invoke.join(", ")}`
    );
  }
  console.log(
    `  steward dimensions: ${gov.matrix.steward_resolution.dimensions.join(", ")}`
  );
  console.log(
    `  governance_lead (fallback): ${gov.matrix.steward_resolution.governance_lead}`
  );

  console.log("\n=== SCENARIOS (3) ===");
  for (const s of gov.scenarios) {
    console.log(
      `  ${s.id} -> expected ${s.expected_verdict} (${s.fields.length} fields)`
    );
  }

  // Sanity assertions.
  const assert = (cond: boolean, msg: string) => {
    if (!cond) {
      console.error(`\n✗ FAILED: ${msg}`);
      process.exit(1);
    }
  };
  assert(gov.agents.length === 5, "expected 5 agent contracts");
  assert(Object.keys(gov.schema.tables).length === 2, "expected 2 tables");
  assert(gov.scenarios.length === 3, "expected 3 scenarios");
  assert(gov.matrix.agent_routing.length >= 5, "expected routing rules");

  console.log("\n✓ M1 acceptance passed — all governed YAML parsed.");
}

main();
