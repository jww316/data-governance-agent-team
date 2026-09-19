/**
 * state.ts — the deterministic half of state resolution (Part 2 design §18–§22).
 *
 *   validate → normalize → derive → compare → materiality → hand-off
 *
 * Everything in this file is pure, LLM-free code driven by
 * governance/state_resolution/*.yaml. Model reasoning is confined to the
 * resolvers. What CAN be deterministic IS deterministic, and this file is where
 * that line is drawn.
 */

import {
  AssemblyConfig,
  AttributeProvenance,
  Change,
  DerivedState,
  MaterialityConfig,
  MaterialityResult,
  ResolverResult,
  RoutingState,
  StateDelta,
  StateResolutionScenario,
} from "./governance";

// ---------------------------------------------------------------------------
// Assembly: validate + normalize
// ---------------------------------------------------------------------------

export interface AssemblyResult {
  ok: boolean;
  status: "assembled" | "unresolved" | "conflicted" | "failed";
  problems: string[];
  routingState: RoutingState;
  provenance: Record<string, AttributeProvenance>;
}

/**
 * Validate the resolver results and build a single routing-state object. If
 * any required resolver is missing or not "resolved", or a routing attribute is
 * missing or below threshold, assembly stops (ok=false). State is never
 * fabricated.
 */
export function assembleState(
  results: ResolverResult[],
  cfg: AssemblyConfig
): AssemblyResult {
  const problems: string[] = [];
  const byId = new Map(results.map((r) => [r.resolverId, r]));

  // Worst status wins: failed > conflicted > unresolved.
  let status: AssemblyResult["status"] = "assembled";
  const rank = { assembled: 0, unresolved: 1, conflicted: 2, failed: 3 } as const;
  const worsen = (s: AssemblyResult["status"]) => {
    if (rank[s] > rank[status]) status = s;
  };

  for (const id of cfg.required_resolvers) {
    const r = byId.get(id);
    if (!r) {
      problems.push(`${id}: no result`);
      worsen("failed");
    } else if (r.status !== "resolved") {
      const detail = r.issues?.length
        ? r.issues.join("; ")
        : r.conflicts?.map((c) => c.note).join("; ") || r.summary;
      problems.push(`${r.resolverName} is ${r.status}: ${detail}`);
      worsen(r.status);
    }
  }

  // Normalize: flatten every resolved attribute, keeping its provenance.
  const provenance: Record<string, AttributeProvenance> = {};
  for (const r of results) {
    if (r.status !== "resolved") continue;
    for (const [name, a] of Object.entries(r.attributes)) {
      provenance[name] = {
        value: a.value,
        confidence: a.confidence,
        evidence: a.evidence,
        resolver: r.resolverId,
        resolvedAt: r.resolvedAt,
        method: a.sourceType,
      };
    }
  }

  const routingState: RoutingState = {};
  for (const name of cfg.routing_attributes) {
    const p = provenance[name];
    if (!p) {
      if (status === "assembled") {
        problems.push(`${name}: not established by any resolver`);
        worsen("unresolved");
      }
      continue;
    }
    if (p.confidence < cfg.confidence_threshold) {
      problems.push(`${name}: confidence ${p.confidence} below threshold`);
      worsen("unresolved");
      continue;
    }
    routingState[name] = p.value;
  }

  return { ok: status === "assembled", status, problems, routingState, provenance };
}

// ---------------------------------------------------------------------------
// Derive
// ---------------------------------------------------------------------------

/**
 * Deterministic derived state (§18.3):
 *   cross_border      = origin_location != destination_location
 *   external_transfer = recipient_type in external_recipient_types
 *   purpose_change    = prior.processing_purpose != current.processing_purpose
 * With no prior state, purpose_change is false. It is a first observation,
 * which the delta reports separately.
 */
export function deriveState(
  current: RoutingState,
  prior: Record<string, unknown> | null,
  cfg: AssemblyConfig
): DerivedState {
  return {
    cross_border: current.origin_location !== current.destination_location,
    external_transfer: cfg.external_recipient_types.includes(
      String(current.recipient_type)
    ),
    purpose_change:
      prior !== null && prior.processing_purpose !== current.processing_purpose,
  };
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

/**
 * Compare prior state to current state, attribute by attribute, over the union
 * of both key sets. Missing prior state is not a failure. The delta is flagged
 * as a first observation, and every current attribute counts as new.
 */
export function computeDelta(
  prior: Record<string, unknown> | null,
  current: Record<string, unknown>
): StateDelta {
  if (!prior) {
    return {
      firstObservation: true,
      entries: Object.entries(current).map(([attribute, value]) => ({
        attribute,
        prior: undefined,
        current: value,
        changed: true,
      })),
    };
  }
  const keys = Array.from(new Set([...Object.keys(prior), ...Object.keys(current)]));
  return {
    firstObservation: false,
    entries: keys.map((attribute) => ({
      attribute,
      prior: prior[attribute],
      current: current[attribute],
      changed: !sameValue(prior[attribute], current[attribute]),
    })),
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Materiality
// ---------------------------------------------------------------------------

/**
 * The Governance Materiality Filter (§21). It is configuration-driven and
 * deterministic. A change is material if any changed attribute's rule says so.
 * An attribute without a rule uses default_change_is_material, so the filter
 * fails safe.
 */
export function evaluateMateriality(
  delta: StateDelta,
  cfg: MaterialityConfig
): MaterialityResult {
  const materialChanges: string[] = [];
  const nonMaterialChanges: string[] = [];
  const reasons: Record<string, string> = {};

  for (const e of delta.entries) {
    if (!e.changed) continue;
    const rule = cfg.materiality_rules[e.attribute];
    const isMaterial = delta.firstObservation
      ? cfg.first_observation_is_material
      : rule
        ? rule.change_is_material
        : cfg.default_change_is_material;
    reasons[e.attribute] = delta.firstObservation
      ? "First observation of this relationship"
      : rule?.reason ?? "No rule configured. Treated as material (fail-safe default).";
    (isMaterial ? materialChanges : nonMaterialChanges).push(e.attribute);
  }

  return {
    material: materialChanges.length > 0,
    firstObservation: delta.firstObservation,
    materialChanges,
    nonMaterialChanges,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Hand-off to the existing Part 1 control plane (§22)
// ---------------------------------------------------------------------------

export interface Handoff {
  /** The compact routing input (§22), shown in the UI and audit. */
  input: Record<string, unknown>;
  /** The normalized Change the unchanged orchestrator evaluates. */
  change: Change;
}

/**
 * Map resolved state to the existing Change shape. The decision-rights matrix
 * is NOT changed. The one vocabulary mapping is that the matrix routes on
 * `cross_jurisdictional_consumption`, which is exactly the resolved
 * `cross_border` fact.
 */
export function buildHandoff(
  scenario: StateResolutionScenario,
  routingState: RoutingState,
  derived: DerivedState,
  materiality: MaterialityResult
): Handoff {
  const input: Record<string, unknown> = {
    asset: scenario.asset.id,
    ...routingState,
    ...derived,
    material_change: materiality.material,
    material_changes: materiality.materialChanges,
  };

  const oc = scenario.observed_event.observed_change;
  const change: Change = {
    source: "state_resolution",
    asset: { scenarioId: scenario.id, domain: scenario.asset.domain },
    state_attributes: {
      domain: scenario.asset.domain,
      asset_id: scenario.asset.id,
      // The asset's existing approved posture (classification, policies).
      ...(scenario.governed_attributes ?? {}),
      // The resolved and derived state.
      ...routingState,
      ...derived,
      originating_geo: routingState.origin_location,
      consuming_geos: [routingState.destination_location],
      cross_jurisdictional_consumption: derived.cross_border,
      material_changes: materiality.materialChanges,
      transfer: {
        source_system: oc.source_system,
        destination_system: oc.destination_system,
        mechanism: oc.mechanism,
        fields: scenario.observed_event.fields,
        integration: scenario.observed_event.integration?.name,
      },
    },
    // The transfer adds no new columns, so it does not DECLARE new PII. The
    // asset's PII status comes from the resolved state above.
    declared: { contains_pii: false },
    decisionEvidence: scenario.decision_evidence,
  };

  return { input, change };
}
