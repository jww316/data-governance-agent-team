/**
 * steward.ts — deterministic steward resolution from the decision-rights matrix
 * (IMPLEMENTATION.md §8). Names are illustrative placeholders (DESIGN.md §10).
 *
 * This is pure and LLM-free. The assignment agent is given this resolution and
 * narrates/confirms it; the names themselves come from the matrix, never invented.
 */

import { Change, StewardAssignment, loadGovernance } from "./governance";

/**
 * Resolve the responsible steward(s) for a change across the matrix dimensions.
 *  - Match the most specific `rules` entry by the change's state.
 *  - If cross_jurisdictional_consumption is true, include cross_border_review.
 *  - If no eligible steward resolves for a required dimension -> coverageGap,
 *    fall back to governance_lead, and surface the gap.
 *
 * `ownerRequired` is true when the run actually needs a human owner (some agent
 * blocked or escalated, or a cross-border review applies). A routine all-PASS
 * change needs no owner, so an unmatched domain is NOT a coverage gap then — it
 * simply proceeds (the 80%, no human involvement; DESIGN.md §6).
 */
export function resolveStewards(
  change: Change,
  ownerRequired = true
): StewardAssignment {
  const gov = loadGovernance();
  const sr = gov.matrix.steward_resolution;
  const state = effectiveState(change);

  // Find all matching rules; prefer the most specific (most matched keys).
  const matches = sr.rules
    .map((rule) => ({
      rule,
      matchedKeys: matchScore(rule.match, state),
    }))
    .filter((m) => m.matchedKeys >= 0) // >=0 means all declared keys matched
    .sort((a, b) => b.matchedKeys - a.matchedKeys);

  const byDimension: Record<string, Record<string, string>> = {};
  if (matches.length > 0) {
    const best = matches[0].rule;
    for (const dim of sr.dimensions) {
      if (best.stewards[dim]) byDimension[dim] = { ...best.stewards[dim] };
    }
  }

  // Cross-border review — adds governance + privacy stewards together (scenario #5).
  let crossBorder: string[] | undefined;
  if (matchScore(sr.cross_border_review.match, state) >= 0) {
    crossBorder = [...sr.cross_border_review.stewards];
  }

  // Coverage gap: a required dimension resolved to no steward — but only counts
  // when a human owner is actually required for this run.
  let coverageGap = false;
  let fallback: string | undefined;
  if (ownerRequired) {
    for (const dim of sr.dimensions) {
      const resolved = byDimension[dim];
      if (!resolved || Object.keys(resolved).length === 0) {
        coverageGap = true;
      }
    }
    if (coverageGap) {
      fallback = sr.governance_lead;
    }
  }

  return { byDimension, crossBorder, coverageGap, fallback };
}

/** Effective state used for matching — the change's resolved state attributes. */
function effectiveState(change: Change): Record<string, any> {
  return {
    ...change.state_attributes,
    domain: change.asset.domain ?? change.state_attributes.domain,
  };
}

/**
 * Returns the number of keys matched if EVERY key in `match` is satisfied by the
 * state; returns -1 if any key mismatches (so the rule does not apply at all).
 */
function matchScore(match: Record<string, any>, state: Record<string, any>): number {
  let score = 0;
  for (const [key, value] of Object.entries(match)) {
    if (state[key] !== value) return -1;
    score++;
  }
  return score;
}

/** Flatten an assignment into a readable list of "Role: Name" strings. */
export function flattenStewards(a: StewardAssignment): string[] {
  const out: string[] = [];
  for (const [dim, roles] of Object.entries(a.byDimension)) {
    for (const [role, name] of Object.entries(roles)) {
      out.push(`${prettyRole(role)} (${dim}): ${name}`);
    }
  }
  if (a.crossBorder && a.crossBorder.length) {
    out.push(`Cross-border review: ${a.crossBorder.join(", ")}`);
  }
  if (a.coverageGap && a.fallback) {
    out.push(`Coverage gap → Governance Lead: ${a.fallback}`);
  }
  return out;
}

function prettyRole(role: string): string {
  return role
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
