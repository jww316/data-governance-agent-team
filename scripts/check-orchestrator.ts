/**
 * M4 acceptance: the orchestrator runs the team in parallel, aggregates the
 * team verdict, runs assignment, and writes audit. The three monitor scenarios
 * must produce PASS / BLOCK / ESCALATE respectively when run headless.
 * Run with: npm run check:orchestrator   (requires ANTHROPIC_API_KEY)
 */
import "./_env";
import { RunEvent, loadGovernance } from "../lib/governance";
import { buildMonitorChange } from "../lib/adapters";
import { runGovernance } from "../lib/orchestrator";

async function runScenario(scenarioId: string) {
  const gov = loadGovernance();
  const scenario = gov.scenarios.find((s) => s.id === scenarioId)!;
  const { change } = buildMonitorChange(scenario, "json", 8);

  const events: RunEvent[] = [];
  const result = await runGovernance(change, (e) => {
    events.push(e);
    if (e.type === "agent_result") {
      console.log(`    [${e.verdict.padEnd(8)}] ${e.agentName}: ${e.reasoning}`);
    }
  });
  return { scenario, result };
}

async function main() {
  const gov = loadGovernance();
  let failures = 0;

  for (const scenario of gov.scenarios) {
    console.log(`\n=== ${scenario.id}  (expect ${scenario.expected_verdict}) ===`);
    const { result } = await runScenario(scenario.id);
    const ok = result.teamVerdict === scenario.expected_verdict;
    console.log(
      `  -> team verdict: ${result.teamVerdict}  ${ok ? "✓" : "✗ MISMATCH"}  (audit ${result.auditId})`
    );
    if (!ok) failures++;
  }

  if (failures > 0) {
    console.error(`\n✗ M4 acceptance FAILED (${failures} scenario(s) off-target).`);
    process.exit(1);
  }
  console.log(
    "\n✓ M4 acceptance passed — PASS / BLOCK / ESCALATE produced headless; audit written."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
