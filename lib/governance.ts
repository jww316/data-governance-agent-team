/**
 * governance.ts — load + parse all governed YAML and expose typed accessors.
 *
 * The governance/ directory is the source of truth (DESIGN.md §5). The engine
 * reads these files; it never hardcodes their content. This module also defines
 * the shared types used across both features so the engine is feature-agnostic
 * (IMPLEMENTATION.md §4).
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Core shared types
// ---------------------------------------------------------------------------

export type Verdict = "PASS" | "BLOCK" | "ESCALATE";

/** A schema column, as it appears under a table in schema.yaml. */
export interface Column {
  name: string;
  type: string;
  nullable?: boolean;
  pii?: boolean;
  pii_category?: string;
  foreign_key?: string;
  quality_rules?: string[];
  notes?: string;
  // Some flows (the gate editor) carry an explicit declared-pii flag.
  declared_pii?: boolean;
  [key: string]: unknown;
}

export interface TableStateAttributes {
  domain: string;
  security_classification?: string;
  contains_pii?: boolean;
  location_zone?: string;
  data_quality_health?: string;
  related_security_policies?: string[];
  regulatory_jurisdictions?: string[];
  originating_geo?: string;
  cross_jurisdictional_consumption?: boolean;
  consuming_geos?: string[];
  [key: string]: unknown;
}

export interface Table {
  description?: string;
  state_attributes: TableStateAttributes;
  columns: Column[];
}

export interface Schema {
  tables: Record<string, Table>;
}

/**
 * Change — the normalized representation evaluated by BOTH features, so the
 * engine never has to know whether it came from the gate or the monitor.
 */
export interface Change {
  source: ChangeSource;
  asset: { table?: string; scenarioId?: string; domain: string };
  /** Resolved effective state attributes for the asset under change. */
  state_attributes: Record<string, any>;
  /** Gate: structured diff of the proposed schema edit. */
  diff?: {
    added: Column[];
    altered: Column[];
    removed: Column[];
  };
  /** Monitor: the generated rows that "landed". */
  records?: Record<string, any>[];
  /** Field-level metadata for monitor scenarios (true vs declared PII, rules). */
  fieldMeta?: ScenarioField[];
  /** What the change itself claims. */
  declared: { contains_pii?: boolean };
  /**
   * Part 2 only: evidence for the governance JUDGMENT (vendor agreement, DPA,
   * approved purposes, …). It is separate from the resolved state, and only
   * agents whose contract permits decision evidence receive it.
   */
  decisionEvidence?: Record<string, any>;
}

/** Where a change came from. "state_resolution" is the Part 2 upstream path. */
export type ChangeSource = "gate" | "monitor" | "state_resolution";

// ---------------------------------------------------------------------------
// Agent contracts (agents/*.yaml)
// ---------------------------------------------------------------------------

export interface AgentContract {
  id: string;
  name: string;
  role_type: string;
  one_liner: string;
  authority: string;
  permitted_scope: string[];
  guardrails: string[];
  escalation_trigger: string;
  logging_obligation: string;
  verdicts: Verdict[];
}

// ---------------------------------------------------------------------------
// Policies (policies.yaml) — loosely typed; agents read it as context.
// ---------------------------------------------------------------------------

export type Policy = Record<string, any>;
export type Policies = Record<string, Policy>;

// ---------------------------------------------------------------------------
// Decision-rights matrix (decision_rights_matrix.yaml)
// ---------------------------------------------------------------------------

export interface MatrixRoutingRule {
  when: Record<string, any>;
  invoke: string[];
}

export interface StewardRule {
  match: Record<string, any>;
  stewards: Record<string, Record<string, string>>;
}

export interface StewardResolution {
  dimensions: string[];
  rules: StewardRule[];
  cross_border_review: {
    match: Record<string, any>;
    stewards: string[];
  };
  governance_lead: string;
  fairness?: { rule: string };
}

export interface DecisionRightsMatrix {
  agent_routing: MatrixRoutingRule[];
  steward_resolution: StewardResolution;
}

// ---------------------------------------------------------------------------
// Scenarios (scenarios.yaml)
// ---------------------------------------------------------------------------

export interface ScenarioField {
  name: string;
  generator: string;
  pattern?: string;
  value?: any;
  options?: any[];
  constraint?: string;
  pii?: boolean;
  declared_pii?: boolean;
}

export interface Scenario {
  id: string;
  label: string;
  expected_verdict: Verdict;
  description: string;
  fields: ScenarioField[];
  state_attributes: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Agent run results & streamed events
// ---------------------------------------------------------------------------

export interface AgentResult {
  agentId: string;
  agentName: string;
  verdict: Verdict;
  reasoning: string;
  details: Record<string, any>;
  stewardsAssigned?: StewardAssignment;
}

export interface StewardAssignment {
  byDimension: Record<string, Record<string, string>>;
  crossBorder?: string[];
  coverageGap?: boolean;
  fallback?: string;
  /**
   * Part 2: state that could not be established (unresolved / conflicted /
   * failed) never reaches the agent team. It goes to this human reviewer instead,
   * who is the matrix's governance lead.
   */
  humanReview?: { steward: string; reason: string };
}

/** The streamed event union (IMPLEMENTATION.md §7). */
export type RunEvent =
  | { type: "run_started"; change: { summary: string; source: string } }
  | {
      type: "monitor_data";
      scenarioId: string;
      label: string;
      format: string;
      records: Record<string, any>[];
      fieldMeta: ScenarioField[];
    }
  | {
      type: "routing";
      agentsSelected: string[];
      matchedRules: { when: Record<string, any>; invoke: string[] }[];
    }
  | { type: "agent_started"; agentId: string; agentName: string; one_liner: string }
  | {
      type: "agent_result";
      agentId: string;
      agentName: string;
      verdict: Verdict;
      reasoning: string;
      details?: Record<string, any>;
    }
  | { type: "assignment"; assignment: StewardAssignment }
  | { type: "team_verdict"; verdict: Verdict }
  | { type: "github"; prUrl?: string; prState?: string; skipped?: boolean; message?: string }
  | { type: "audit_written"; auditId: string }
  | { type: "run_complete"; verdict: Verdict }
  | { type: "error"; message: string }
  | StateResolutionEvent;

// ---------------------------------------------------------------------------
// Part 2 — state resolution (PART2_STATE_RESOLUTION_DESIGN.md)
//
// State (what is true now) is kept separate from policy (what is permitted) and
// from governance judgment (PASS / BLOCK / ESCALATE). Resolvers establish state
// only. The assembler, delta and materiality filter are deterministic.
// ---------------------------------------------------------------------------

/** Resolver status. "failed" is a technical failure, which is never state. */
export type ResolverStatus = "resolved" | "unresolved" | "conflicted" | "failed";

/** How an attribute was established, shown in the UI so no scripted logic
 *  passes for model reasoning (DESIGN.md §10). */
export type ResolutionMethod = "authoritative_lookup" | "model";

export interface ResolvedAttribute {
  value: unknown;
  /** Attribute-level confidence, 0..1 (§16). */
  confidence: number;
  /** Evidence references that support the value (§17). */
  evidence: string[];
  sourceType: ResolutionMethod;
}

export interface ResolverResult {
  resolverId: string;
  resolverName: string;
  method: ResolutionMethod;
  status: ResolverStatus;
  attributes: Record<string, ResolvedAttribute>;
  /** Concise summary only. Hidden model reasoning is never stored. */
  summary: string;
  resolvedAt: string;
  /** Conflicted: both sides of the disagreement are preserved (§30). */
  conflicts?: { attribute: string; evidence: string[]; note: string }[];
  /** Why the status is not "resolved" (low confidence, bad value, error, …). */
  issues?: string[];
}

export interface ResolverContract {
  id: string;
  name: string;
  question: string;
  method: ResolutionMethod;
  model_fallback: boolean;
  authoritative_source?: string;
  evidence_families: string[];
  outputs: Record<string, { type?: string; taxonomy?: string }>;
  guardrails: string[];
}

export interface Taxonomies {
  classification: {
    values: string[];
    catalog_mapping: Record<string, string>;
    personal_values: string[];
    precedence: string[];
  };
  recipient_type: {
    values: string[];
    registry_mapping: {
      relationship_type: string;
      processing_role?: string;
      recipient_type: string;
    }[];
  };
  processing_purpose: { values: string[] };
}

export interface AssemblyConfig {
  confidence_threshold: number;
  required_resolvers: string[];
  routing_attributes: string[];
  external_recipient_types: string[];
}

export interface MaterialityConfig {
  materiality_rules: Record<string, { change_is_material: boolean; reason?: string }>;
  default_change_is_material: boolean;
  first_observation_is_material: boolean;
}

/** The observed technical event: evidence, never resolved state (§4.3, §7). */
export interface ObservedEvent {
  event_id: string;
  event_type: string;
  asset_id: string;
  observed_change: Record<string, any>;
  fields: string[];
  integration?: { name: string; description?: string };
}

export type EvidencePackage = Record<string, Record<string, any>>;

export interface StateResolutionScenario {
  id: string;
  label: string;
  expected_verdict: Verdict;
  description: string;
  asset: { id: string; domain: string };
  observed_event: ObservedEvent;
  evidence: EvidencePackage;
  /** Optional: a missing prior state means this is a first observation (§30). */
  prior_state?: {
    recorded_at?: string;
    recorded_by?: string;
    attributes: Record<string, unknown>;
  };
  governed_attributes?: Record<string, any>;
  decision_evidence?: Record<string, any>;
}

/** Provenance of one assembled attribute (§17). */
export interface AttributeProvenance {
  value: unknown;
  confidence: number;
  evidence: string[];
  resolver: string;
  resolvedAt: string;
  method: ResolutionMethod;
}

export type RoutingState = Record<string, unknown>;

export interface DerivedState {
  cross_border: boolean;
  external_transfer: boolean;
  purpose_change: boolean;
}

export interface StateDeltaEntry {
  attribute: string;
  prior: unknown;
  current: unknown;
  changed: boolean;
}

export interface StateDelta {
  firstObservation: boolean;
  entries: StateDeltaEntry[];
}

export interface MaterialityResult {
  material: boolean;
  firstObservation: boolean;
  materialChanges: string[];
  nonMaterialChanges: string[];
  /** attribute -> the configured reason it was (or wasn't) material. */
  reasons: Record<string, string>;
}

export type StateResolutionOutcome =
  | "handed_off" // material → the existing Part 1 control plane
  | "not_material" // logged; the agent team is not invoked
  | "unresolved" // stopped before routing; human review
  | "conflicted"
  | "failed";

export type StateResolutionEvent =
  | {
      type: "observed_event";
      scenarioId: string;
      label: string;
      event: ObservedEvent;
      evidence: EvidencePackage;
    }
  | {
      type: "state_resolution_started";
      resolvers: { id: string; name: string; method: ResolutionMethod }[];
    }
  | {
      type: "resolver_started";
      resolverId: string;
      resolverName: string;
      method: ResolutionMethod;
      question: string;
    }
  | { type: "resolver_result"; result: ResolverResult }
  | {
      type: "state_assembled";
      ok: boolean;
      status: "assembled" | "unresolved" | "conflicted" | "failed";
      problems: string[];
      routingState: RoutingState;
      derivedState?: DerivedState;
      provenance: Record<string, AttributeProvenance>;
    }
  | { type: "state_delta"; delta: StateDelta; priorRecordedAt?: string }
  | { type: "materiality"; result: MaterialityResult }
  | {
      type: "state_resolution_complete";
      outcome: StateResolutionOutcome;
      message: string;
    }
  | { type: "governance_handoff"; input: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const GOV_DIR = path.join(process.cwd(), "governance");

function readYaml<T>(relativePath: string): T {
  const full = path.join(GOV_DIR, relativePath);
  const raw = fs.readFileSync(full, "utf8");
  return yaml.load(raw) as T;
}

export interface Governance {
  schema: Schema;
  policies: Policies;
  matrix: DecisionRightsMatrix;
  scenarios: Scenario[];
  agents: AgentContract[];
  agentsById: Record<string, AgentContract>;
}

let _cache: Governance | null = null;

/**
 * Load and parse all governed YAML. Cached after first read (the files are the
 * stable source of truth for a running process).
 */
export function loadGovernance(force = false): Governance {
  if (_cache && !force) return _cache;

  const schema = readYaml<Schema>("schema.yaml");
  const policies = readYaml<Policies>("policies.yaml");
  const matrix = readYaml<DecisionRightsMatrix>("decision_rights_matrix.yaml");
  const scenariosFile = readYaml<{ scenarios: Scenario[] }>("scenarios.yaml");

  const agentFiles = [
    "classification_pii.yaml",
    "quality.yaml",
    "policy_jurisdiction.yaml",
    "assignment_steward.yaml",
    "relationship_lineage.yaml",
  ];
  const agents = agentFiles.map((f) =>
    readYaml<AgentContract>(path.join("agents", f))
  );
  const agentsById: Record<string, AgentContract> = {};
  for (const a of agents) agentsById[a.id] = a;

  _cache = {
    schema,
    policies,
    matrix,
    scenarios: scenariosFile.scenarios,
    agents,
    agentsById,
  };
  return _cache;
}

// ---------------------------------------------------------------------------
// Part 2 loader — governance/state_resolution/ (same YAML-as-source-of-truth
// philosophy; the engine reads these, it never hardcodes their content).
// ---------------------------------------------------------------------------

export interface StateResolutionConfig {
  resolvers: ResolverContract[];
  resolversById: Record<string, ResolverContract>;
  taxonomies: Taxonomies;
  assembly: AssemblyConfig;
  materiality: MaterialityConfig;
  scenario: StateResolutionScenario;
}

const SR_DIR = "state_resolution";
const RESOLVER_FILES = [
  "classification.yaml",
  "location.yaml",
  "recipient.yaml",
  "purpose.yaml",
];

let _srCache: StateResolutionConfig | null = null;

export function loadStateResolution(force = false): StateResolutionConfig {
  if (_srCache && !force) return _srCache;

  const resolvers = RESOLVER_FILES.map((f) =>
    readYaml<ResolverContract>(path.join(SR_DIR, "resolvers", f))
  );
  const resolversById: Record<string, ResolverContract> = {};
  for (const r of resolvers) resolversById[r.id] = r;

  _srCache = {
    resolvers,
    resolversById,
    taxonomies: readYaml<Taxonomies>(path.join(SR_DIR, "taxonomies.yaml")),
    assembly: readYaml<AssemblyConfig>(path.join(SR_DIR, "assembly.yaml")),
    materiality: readYaml<MaterialityConfig>(path.join(SR_DIR, "materiality.yaml")),
    scenario: readYaml<StateResolutionScenario>(
      path.join(SR_DIR, "scenario_crm_campaigncloud.yaml")
    ),
  };
  return _srCache;
}

/** Convenience accessors. */
export function getAgentContract(id: string): AgentContract {
  const gov = loadGovernance();
  const contract = gov.agentsById[id];
  if (!contract) throw new Error(`Unknown agent contract: ${id}`);
  return contract;
}

export function getTable(name: string): Table {
  const gov = loadGovernance();
  const table = gov.schema.tables[name];
  if (!table) throw new Error(`Unknown table: ${name}`);
  return table;
}

// ---------------------------------------------------------------------------
// Serializable view model for the UI (the left panel + editor read from here,
// never hardcoded — IMPLEMENTATION.md §12).
// ---------------------------------------------------------------------------

export interface GovernanceView {
  agents: AgentContract[];
  policies: { key: string; description: string }[];
  tables: {
    name: string;
    description?: string;
    state_attributes: TableStateAttributes;
    columns: Column[];
  }[];
  scenarios: Scenario[];
  /** Part 2: the state-resolution scenario and its resolver contracts. */
  stateResolution: {
    scenario: Pick<
      StateResolutionScenario,
      "id" | "label" | "description" | "expected_verdict"
    >;
    resolvers: ResolverContract[];
  };
}

export function getGovernanceView(): GovernanceView {
  const gov = loadGovernance();
  const sr = loadStateResolution();
  return {
    stateResolution: {
      scenario: {
        id: sr.scenario.id,
        label: sr.scenario.label,
        description: sr.scenario.description,
        expected_verdict: sr.scenario.expected_verdict,
      },
      resolvers: sr.resolvers,
    },
    agents: gov.agents,
    policies: Object.entries(gov.policies).map(([key, p]) => ({
      key,
      description:
        (p && typeof p === "object" && typeof p.description === "string"
          ? p.description
          : "") || "",
    })),
    tables: Object.entries(gov.schema.tables).map(([name, t]) => ({
      name,
      description: t.description,
      state_attributes: t.state_attributes,
      columns: t.columns,
    })),
    scenarios: gov.scenarios,
  };
}
