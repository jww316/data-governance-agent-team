/**
 * routing.ts — the deterministic routing layer.
 *
 * Evaluates `decision_rights_matrix.yaml > agent_routing` against a change's
 * effective state to decide WHICH agents fire. This is pure and LLM-free: only
 * agent *judgment* is autonomous; the routing that invokes them is deterministic
 * by design (DESIGN.md §4, IMPLEMENTATION.md §5).
 */

import {
  Change,
  Column,
  MatrixRoutingRule,
  loadGovernance,
} from "./governance";

export interface RoutingFacts {
  contains_pii: boolean;
  cross_jurisdictional_consumption: boolean;
  has_quality_rules: boolean;
  has_foreign_key: boolean;
}

export interface RoutingResult {
  agentIds: string[];
  matchedRules: MatrixRoutingRule[];
  facts: RoutingFacts;
}

const ASSIGNMENT = "assignment_steward";

/**
 * Collect the columns "affected" by a change: the diff's added/altered/removed
 * columns plus, for a gate change against a known table, that table's baseline
 * columns (the asset itself is affected, so its lineage/quality characteristics
 * are in scope).
 */
function affectedColumns(change: Change): Column[] {
  const cols: Column[] = [];
  if (change.diff) {
    cols.push(...change.diff.added, ...change.diff.altered, ...change.diff.removed);
  }
  if (change.asset.table) {
    const gov = loadGovernance();
    const table = gov.schema.tables[change.asset.table];
    if (table) cols.push(...table.columns);
  }
  return cols;
}

/**
 * Derive the boolean facts the matrix routes on (IMPLEMENTATION.md §5):
 *  - contains_pii: declared OR detected from state OR any affected/landed field is PII
 *  - cross_jurisdictional_consumption: from effective state
 *  - has_quality_rules: any affected column carries quality_rules (or a landed
 *    field declares a constraint)
 *  - has_foreign_key: any affected column has a foreign_key
 */
export function deriveFacts(change: Change): RoutingFacts {
  const cols = affectedColumns(change);
  const fields = change.fieldMeta ?? [];

  const contains_pii =
    change.declared.contains_pii === true ||
    change.state_attributes.contains_pii === true ||
    cols.some((c) => c.pii === true) ||
    fields.some((f) => f.pii === true);

  const cross_jurisdictional_consumption =
    change.state_attributes.cross_jurisdictional_consumption === true;

  const has_quality_rules =
    cols.some((c) => Array.isArray(c.quality_rules) && c.quality_rules.length > 0) ||
    fields.some((f) => typeof f.constraint === "string" && f.constraint.length > 0);

  const has_foreign_key = cols.some(
    (c) => typeof c.foreign_key === "string" && c.foreign_key.length > 0
  );

  return {
    contains_pii,
    cross_jurisdictional_consumption,
    has_quality_rules,
    has_foreign_key,
  };
}

/** A rule matches when every key in its `when` is satisfied by the facts. */
function ruleMatches(rule: MatrixRoutingRule, facts: RoutingFacts): boolean {
  const factBag: Record<string, boolean> = { ...facts, always: true };
  return Object.entries(rule.when).every(([key, value]) => factBag[key] === value);
}

/**
 * Evaluate the matrix and return the selected agents, the rules that matched,
 * and the derived facts. The `invoke` lists are unioned preserving order; the
 * assignment agent always runs LAST because it consumes the others' results.
 */
export function selectAgents(change: Change): RoutingResult {
  const gov = loadGovernance();
  const facts = deriveFacts(change);

  const matchedRules: MatrixRoutingRule[] = [];
  const ordered: string[] = [];

  for (const rule of gov.matrix.agent_routing) {
    if (!ruleMatches(rule, facts)) continue;
    matchedRules.push(rule);
    for (const id of rule.invoke) {
      if (!ordered.includes(id)) ordered.push(id);
    }
  }

  // The assignment agent's rule is `always: true`, so it always routes; force it
  // to trail the others since it consumes their verdicts.
  const agentIds = ordered.filter((id) => id !== ASSIGNMENT);
  agentIds.push(ASSIGNMENT);

  return { agentIds, matchedRules, facts };
}
