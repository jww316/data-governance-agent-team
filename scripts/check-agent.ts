/**
 * M3 acceptance: a single agent runs against a change via a REAL Anthropic call
 * and returns a parsed verdict.
 *   - Classification agent BLOCKs a customers change that adds undeclared PII
 *     with no protective policy.
 *   - Classification agent PASSes a benign change.
 * Run with: npm run check:agent   (requires ANTHROPIC_API_KEY in .env.local)
 */
import "./_env";
import { Change, getAgentContract, getTable } from "../lib/governance";
import { runAgent } from "../lib/agents";

async function main() {
  const contract = getAgentContract("classification_pii");
  let failures = 0;

  // --- Case 1: undeclared PII, no protective policy -> expect BLOCK ----------
  const piiChange: Change = {
    source: "gate",
    asset: { table: "customers", domain: "Customer" },
    state_attributes: getTable("customers").state_attributes,
    diff: {
      added: [
        {
          // A national identifier added with NO pii flag and NO policy — a
          // direct identifier the agent must catch and BLOCK.
          name: "national_id",
          type: "text",
          nullable: false,
          pii: false,
          notes: "Imported from vendor feed.",
        },
      ],
      altered: [],
      removed: [],
    },
    declared: { contains_pii: false },
  };

  console.log("→ Running Classification & PII agent on undeclared-PII change...");
  const r1 = await runAgent(contract, piiChange);
  console.log(`   verdict: ${r1.verdict}`);
  console.log(`   reasoning: ${r1.reasoning}\n`);
  if (r1.verdict !== "BLOCK") {
    console.error(`✗ expected BLOCK, got ${r1.verdict}`);
    failures++;
  }

  // --- Case 2: a benign, well-governed change -> expect PASS ------------------
  const benignChange: Change = {
    source: "gate",
    asset: { table: "customers", domain: "Customer" },
    state_attributes: getTable("customers").state_attributes,
    diff: {
      added: [
        {
          name: "preferred_language",
          type: "text",
          nullable: true,
          pii: false,
          notes: "UI locale preference, e.g. en-US. Not an identifier.",
        },
      ],
      altered: [],
      removed: [],
    },
    declared: { contains_pii: false },
  };

  console.log("→ Running Classification & PII agent on a benign change...");
  const r2 = await runAgent(contract, benignChange);
  console.log(`   verdict: ${r2.verdict}`);
  console.log(`   reasoning: ${r2.reasoning}\n`);
  if (r2.verdict !== "PASS") {
    console.error(`✗ expected PASS, got ${r2.verdict}`);
    failures++;
  }

  if (failures > 0) {
    console.error(`✗ M3 acceptance FAILED (${failures} case(s)).`);
    process.exit(1);
  }
  console.log("✓ M3 acceptance passed — real agent call, JSON parsed reliably.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
