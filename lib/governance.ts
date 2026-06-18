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
  source: "gate" | "monitor";
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
}

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
  | { type: "error"; message: string };

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
}

export function getGovernanceView(): GovernanceView {
  const gov = loadGovernance();
  return {
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
