/**
 * agents.ts — build an agent's prompt from its contract, call Anthropic, and
 * parse a strict-JSON verdict (IMPLEMENTATION.md §6).
 *
 * Each agent is a REAL LLM call. The YAML contract becomes the system prompt;
 * the user message carries only what the contract's permitted_scope allows. The
 * model must return strict JSON; we parse defensively, retry once, and on
 * persistent failure ESCALATE — never silently PASS.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  AgentContract,
  AgentResult,
  Change,
  Verdict,
  loadGovernance,
} from "./governance";

/** Single configurable model constant (IMPLEMENTATION.md §1). */
export const AGENT_MODEL = process.env.AGENT_MODEL || "claude-sonnet-4-6";

// Headroom so a verbose but valid JSON verdict is never truncated mid-string.
const MAX_TOKENS = 2048;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env.local (see .env.local.example)."
      );
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/** Build the system prompt from the contract — its full governance authority. */
export function buildSystemPrompt(contract: AgentContract): string {
  const lines: string[] = [];
  lines.push(
    `You are the "${contract.name}" (id: ${contract.id}) — one member of a data`,
    `governance agent team. You operate under a declarative contract. Stay strictly`,
    `within it. Governance is an operational control plane: your verdict has real`,
    `consequence (it can block a change), so be rigorous and defensible.`,
    ``,
    `ROLE: ${contract.one_liner}`,
    ``,
    `AUTHORITY:`,
    indent(contract.authority),
    ``,
    `PERMITTED SCOPE (you may rely only on what is provided to you within this scope):`,
    ...contract.permitted_scope.map((s) => `  - ${s}`),
    ``,
    `GUARDRAILS (these are binding rules, not suggestions):`,
    ...contract.guardrails.map((g) => `  - ${g}`),
    ``,
    `ESCALATION TRIGGER:`,
    indent(contract.escalation_trigger),
    ``,
    `LOGGING OBLIGATION (reflect this in your reasoning):`,
    indent(contract.logging_obligation),
    ``,
    `ALLOWED VERDICTS: ${contract.verdicts.join(", ")}.`,
    `You MUST choose exactly one of these verdicts.`,
    ``,
    `OUTPUT FORMAT — return STRICT JSON only. No prose, no markdown, no code fences.`,
    `Exactly this shape:`,
    `{"verdict": "<one of ${contract.verdicts.join("|")}>", "reasoning": "<concise, 1-3 sentences citing the specific rule/field that drove the verdict>", "details": { ... any structured findings ... }}`
  );
  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => "  " + l.trim())
    .join("\n");
}

export interface AgentContextExtras {
  /** Prior agent results, supplied to the assignment agent. */
  priorResults?: AgentResult[];
  /** Deterministic steward resolution, supplied to the assignment agent. */
  stewardResolution?: unknown;
  /** Whether a human owner is actually required (some agent blocked/escalated). */
  ownerRequired?: boolean;
}

/**
 * Build the user message — only the parts of the world the contract's scope
 * permits. This keeps each agent within its authority and is itself a
 * demonstrable governance property.
 */
export function buildUserMessage(
  contract: AgentContract,
  change: Change,
  extras: AgentContextExtras = {}
): string {
  const gov = loadGovernance();
  const sections: string[] = [];

  // The change under evaluation (all agents see this).
  sections.push("## CHANGE UNDER EVALUATION");
  sections.push("```json");
  sections.push(
    JSON.stringify(
      {
        source: change.source,
        asset: change.asset,
        state_attributes: change.state_attributes,
        declared: change.declared,
        diff: change.diff,
        // Cap landed records so the prompt stays legible; the sample is enough.
        records: change.records ? change.records.slice(0, 10) : undefined,
        field_metadata: change.fieldMeta,
      },
      null,
      2
    )
  );
  sections.push("```");
  sections.push(
    "",
    "> Reading the fields: `state_attributes` is the asset's CURRENT approved",
    "> classification (authoritative for existing PII). `declared.contains_pii`",
    "> states only whether THIS change is declared to introduce NEW PII via its",
    "> added/altered columns — it is NOT a re-classification of the existing asset.",
    "> Evaluate the change on its merits; do not treat a `declared.contains_pii:",
    "> false` as an attempt to strip protection from PII the baseline already has."
  );

  // Schema baseline — agents whose scope mentions the schema/baseline.
  if (mentions(contract, ["schema", "baseline", "state_attributes", "relationship", "foreign_key"])) {
    if (change.asset.table && gov.schema.tables[change.asset.table]) {
      sections.push("\n## SCHEMA BASELINE (current approved state of the affected table)");
      sections.push("```yaml");
      sections.push(
        dumpYamlish({ [change.asset.table]: gov.schema.tables[change.asset.table] })
      );
      sections.push("```");
    } else {
      sections.push("\n## SCHEMA BASELINE");
      sections.push("(No matching governed table; evaluate the change on its own terms.)");
    }
  }

  // Policies — agents whose scope mentions policies / quality rules.
  if (mentions(contract, ["policies.yaml", "policy", "quality_rules", "rule library", "cross-border", "retention"])) {
    sections.push("\n## ACTIVE POLICIES (policies.yaml)");
    sections.push("```json");
    sections.push(JSON.stringify(gov.policies, null, 2));
    sections.push("```");
  }

  // Assignment agent: matrix steward resolution + prior verdicts.
  if (contract.id === "assignment_steward") {
    sections.push("\n## DECISION-RIGHTS MATRIX — steward_resolution");
    sections.push("```json");
    sections.push(JSON.stringify(gov.matrix.steward_resolution, null, 2));
    sections.push("```");
    if (extras.stewardResolution) {
      sections.push("\n## DETERMINISTIC STEWARD RESOLUTION (computed from the matrix for THIS change)");
      sections.push("Use these exact names; do not invent stewards.");
      sections.push("```json");
      sections.push(JSON.stringify(extras.stewardResolution, null, 2));
      sections.push("```");
    }
    if (extras.priorResults && extras.priorResults.length) {
      sections.push("\n## VERDICTS FROM THE OTHER AGENTS IN THIS RUN");
      sections.push("```json");
      sections.push(
        JSON.stringify(
          extras.priorResults.map((r) => ({
            agentId: r.agentId,
            verdict: r.verdict,
            reasoning: r.reasoning,
          })),
          null,
          2
        )
      );
      sections.push("```");
    }
    const ownerRequired = extras.ownerRequired ?? true;
    sections.push(
      `\nA human owner is ${ownerRequired ? "REQUIRED" : "NOT required"} for this run` +
        ` (derived from the other agents' verdicts and cross-border status).`,
      "\nTASK: Resolve the responsible steward(s) across compliance, technical, and",
      "business dimensions for this change. You do NOT block.",
      "- If a human owner is NOT required (every other agent PASSED and no cross-border",
      "  review applies), this is a routine change in the 80% — verdict PASS, with no",
      "  coverage gap, even if no domain-specific steward rule matched.",
      "- If a human owner IS required (some agent BLOCKED or ESCALATED, or cross-border",
      "  review applies), your verdict is ESCALATE and you must name the human",
      "  steward(s) who now own it, using the deterministic resolution above.",
      "- Only when an owner is required AND the matrix yields no eligible steward for a",
      "  required dimension, set details.coverageGap=true and ESCALATE to the",
      "  governance lead (book scenario #3)."
    );
  }

  return sections.join("\n");
}

function mentions(contract: AgentContract, needles: string[]): boolean {
  const hay = contract.permitted_scope.join(" ").toLowerCase();
  return needles.some((n) => hay.includes(n.toLowerCase()));
}

/** Minimal YAML-ish dump for readability in the prompt (objects/arrays). */
function dumpYamlish(obj: unknown): string {
  // We only need it human-legible for the model; JSON is unambiguous and fine.
  return JSON.stringify(obj, null, 2);
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

interface ParsedVerdict {
  verdict: Verdict;
  reasoning: string;
  details: Record<string, any>;
}

/** Strip accidental code fences and isolate the JSON object. */
function extractJson(raw: string): string {
  let text = raw.trim();
  // Remove ```json ... ``` or ``` ... ``` fences.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // If there's surrounding prose, grab the outermost { ... }.
  if (!text.startsWith("{")) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      text = text.slice(first, last + 1);
    }
  }
  return text;
}

function parseVerdict(raw: string, contract: AgentContract): ParsedVerdict {
  const json = extractJson(raw);
  const obj = JSON.parse(json) as Record<string, any>;
  let verdict = String(obj.verdict || "").toUpperCase() as Verdict;
  if (!contract.verdicts.includes(verdict)) {
    // An out-of-contract verdict is itself a reason not to trust the call.
    throw new Error(
      `Verdict "${obj.verdict}" is not in this agent's allowed set [${contract.verdicts.join(
        ", "
      )}]`
    );
  }
  const reasoning = String(obj.reasoning || "").trim() || "(no reasoning provided)";
  const details =
    obj.details && typeof obj.details === "object" ? obj.details : {};
  return { verdict, reasoning, details };
}

// ---------------------------------------------------------------------------
// The agent call
// ---------------------------------------------------------------------------

/**
 * Run a single agent against a change. Real Anthropic call; defensive parse;
 * one retry; ESCALATE-on-failure (never silent PASS).
 */
export async function runAgent(
  contract: AgentContract,
  change: Change,
  extras: AgentContextExtras = {}
): Promise<AgentResult> {
  const system = buildSystemPrompt(contract);
  const user = buildUserMessage(contract, change, extras);

  const attempt = async (): Promise<ParsedVerdict> => {
    const resp = await client().messages.create({
      model: AGENT_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return parseVerdict(text, contract);
  };

  try {
    const parsed = await attempt();
    return toResult(contract, parsed);
  } catch (firstErr) {
    // Retry once before giving up.
    try {
      const parsed = await attempt();
      return toResult(contract, parsed);
    } catch (secondErr) {
      const msg =
        secondErr instanceof Error ? secondErr.message : String(secondErr);
      // Assignment never blocks; everyone else ESCALATEs an unparseable verdict.
      const fallback: Verdict = "ESCALATE";
      return {
        agentId: contract.id,
        agentName: contract.name,
        verdict: fallback,
        reasoning: `Unparseable or invalid model verdict after retry — escalating rather than guessing. (${msg})`,
        details: { error: "unparseable_verdict" },
      };
    }
  }
}

function toResult(contract: AgentContract, parsed: ParsedVerdict): AgentResult {
  return {
    agentId: contract.id,
    agentName: contract.name,
    verdict: parsed.verdict,
    reasoning: parsed.reasoning,
    details: parsed.details,
  };
}
