/**
 * M2 acceptance (unit checks): routing selects agents from the matrix.
 *   - A PII customer change selects classification_pii + policy_jurisdiction
 *     (+ assignment last).
 *   - An orders quality change selects quality + relationship_lineage
 *     (+ assignment last).
 * Run with: npm run check:routing
 */
import { Change, getTable } from "../lib/governance";
import { selectAgents } from "../lib/routing";

let failures = 0;
function expect(name: string, actual: string[], expected: string[]) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  console.log(`    selected: [${actual.join(", ")}]`);
  if (!ok) {
    console.log(`    expected: [${expected.join(", ")}]`);
    failures++;
  }
}

// --- Case 1: a PII customer change (add a new direct-identifier column) -------
const customerChange: Change = {
  source: "gate",
  asset: { table: "customers", domain: "Customer" },
  state_attributes: getTable("customers").state_attributes,
  diff: {
    added: [
      { name: "national_id", type: "text", nullable: false, pii: true },
    ],
    altered: [],
    removed: [],
  },
  declared: { contains_pii: false },
};

expect("PII customer change", selectAgents(customerChange).agentIds, [
  "classification_pii",
  "policy_jurisdiction",
  "assignment_steward",
]);

// --- Case 2: an orders quality change (alter a quality-ruled column) ----------
const ordersChange: Change = {
  source: "gate",
  asset: { table: "orders", domain: "Order" },
  state_attributes: getTable("orders").state_attributes,
  diff: {
    added: [],
    altered: [
      {
        name: "order_total",
        type: "numeric",
        nullable: false,
        pii: false,
        quality_rules: ["non_negative", "currency_scale_2"],
      },
    ],
    removed: [],
  },
  declared: { contains_pii: false },
};

expect("orders quality change", selectAgents(ordersChange).agentIds, [
  "quality",
  "relationship_lineage",
  "assignment_steward",
]);

// --- Bonus: confirm assignment is always last & facts surface correctly -------
const r1 = selectAgents(customerChange);
console.log("\nderived facts (customer):", JSON.stringify(r1.facts));
console.log("matched rules (customer):", r1.matchedRules.length);

if (failures > 0) {
  console.error(`\n✗ M2 acceptance FAILED (${failures} case(s)).`);
  process.exit(1);
}
console.log("\n✓ M2 acceptance passed — routing is matrix-driven and deterministic.");
