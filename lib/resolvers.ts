/**
 * resolvers.ts — the four specialized state resolvers (Part 2 design §9–§15).
 *
 * Each resolver answers ONE narrow question about the observed event ("what
 * kind of data?", "where?", "who receives it?", "why?"). It sees only the
 * evidence families its contract allows, and it returns a common
 * ResolverResult: status, attribute-level confidence, evidence, and a concise
 * summary.
 *
 * Two ways to resolve, stated per contract and shown in the UI:
 *  - authoritative_lookup: deterministic code reading a source of record
 *    (catalog, system inventory, vendor registry). If that source does not
 *    cover the evidence, the resolver falls back to the model when its contract
 *    allows (model_fallback).
 *  - model: a real LLM call through the shared client (lib/agents.ts). The
 *    Purpose resolver works this way because purpose must be interpreted.
 *
 * Resolvers establish STATE only. They never decide whether something is
 * permitted. That is the governance agents' job downstream.
 */

import {
  EvidencePackage,
  ObservedEvent,
  ResolutionMethod,
  ResolvedAttribute,
  ResolverContract,
  ResolverResult,
  ResolverStatus,
  StateResolutionConfig,
} from "./governance";
import { ModelCall, extractJson } from "./agents";

export interface ResolverInput {
  event: ObservedEvent;
  evidence: EvidencePackage;
}

export interface ResolverDeps {
  /** The model call. Offline checks pass fixture responses here. */
  callModel: ModelCall;
  now?: () => Date;
}

/** What a lookup or model produces, before normalization against the contract. */
interface Draft {
  method: ResolutionMethod;
  status: ResolverStatus;
  attributes: Record<string, ResolvedAttribute>;
  summary: string;
  conflicts?: ResolverResult["conflicts"];
  issues?: string[];
}

// ---------------------------------------------------------------------------
// Evidence scoping — each resolver sees only its allowed evidence families.
// ---------------------------------------------------------------------------

export function scopeEvidence(
  contract: ResolverContract,
  evidence: EvidencePackage
): EvidencePackage {
  const scoped: EvidencePackage = {};
  for (const family of contract.evidence_families) {
    if (evidence[family]) scoped[family] = evidence[family];
  }
  return scoped;
}

// ---------------------------------------------------------------------------
// Deterministic authoritative lookups. Each returns null when its source of
// record does not cover the evidence, which means "fall back to the model".
// ---------------------------------------------------------------------------

type Lookup = (
  input: ResolverInput,
  cfg: StateResolutionConfig
) => Draft | null;

const attr = (
  value: unknown,
  evidence: string[],
  confidence = 1
): ResolvedAttribute => ({
  value,
  confidence,
  evidence,
  sourceType: "authoritative_lookup",
});

/** Classification: the enterprise catalog, when it authoritatively covers every field. */
const classificationLookup: Lookup = ({ event, evidence }, cfg) => {
  const data = evidence.data_evidence;
  const catalog: Record<string, { classification?: string; authoritative?: boolean }> =
    data?.catalog ?? {};
  const tax = cfg.taxonomies.classification;
  const { source_system, source_structure } = event.observed_change;

  const fields = event.fields.map((field) => {
    const ref = `${source_system}.${source_structure}.${field}`;
    const entry = catalog[ref];
    const mapped = entry?.classification
      ? tax.catalog_mapping[entry.classification]
      : undefined;
    return { field, ref, entry, mapped };
  });
  // Not authoritative for every transferred field → not a lookup case.
  if (fields.some((f) => !f.entry?.authoritative || !f.mapped)) return null;

  // Future-conflict support (§15): content inspection disagreeing with the catalog.
  const inspection: Record<string, { detected?: string }> =
    data?.content_inspection ?? {};
  const isPersonal = (v?: string) => !!v && tax.personal_values.includes(v);
  const conflicts: NonNullable<ResolverResult["conflicts"]> = [];
  for (const f of fields) {
    const detected = inspection[f.ref]?.detected;
    const detectedMapped = detected ? tax.catalog_mapping[detected] ?? detected : undefined;
    if (detectedMapped && isPersonal(detectedMapped) !== isPersonal(f.mapped)) {
      conflicts.push({
        attribute: "contains_pii",
        evidence: [`catalog:${f.ref}`, `content_inspection:${f.ref}`],
        note: `Catalog says ${f.entry!.classification}; content inspection detected ${detected}.`,
      });
    }
  }

  const piiFields = fields.filter((f) => isPersonal(f.mapped));
  const classification =
    tax.precedence.find((v) => fields.some((f) => f.mapped === v)) ?? fields[0].mapped!;
  const taxonomyRef = String(data?.taxonomy ?? "classification_taxonomy");

  const attributes = {
    contains_pii: attr(
      piiFields.length > 0,
      (piiFields.length ? piiFields : fields).map((f) => `catalog:${f.ref}`)
    ),
    classification: attr(classification, [taxonomyRef]),
  };

  if (conflicts.length) {
    return {
      method: "authoritative_lookup",
      status: "conflicted",
      attributes,
      conflicts,
      summary: `Catalog classification and content inspection disagree for ${conflicts.length} field(s).`,
    };
  }
  return {
    method: "authoritative_lookup",
    status: "resolved",
    attributes,
    summary: piiFields.length
      ? `${piiFields.length} of ${fields.length} transferred fields are authoritatively catalogued as PII (${piiFields
          .map((f) => f.field)
          .join(", ")}).`
      : `None of the ${fields.length} transferred fields is catalogued as personal data.`,
  };
};

/** Location: hosting country from the system inventory for both ends. */
const locationLookup: Lookup = ({ event, evidence }) => {
  const tm = evidence.technical_metadata;
  if (!tm || tm.source_of_record !== "system_inventory") return null;
  const { source_system, destination_system } = event.observed_change;
  const src = tm.source;
  const dst = tm.destination;
  if (src?.system !== source_system || dst?.system !== destination_system) return null;
  if (!src.hosting_country || !dst.hosting_country) return null;

  return {
    method: "authoritative_lookup",
    status: "resolved",
    attributes: {
      origin_location: attr(src.hosting_country, [`system_inventory:${src.system}`]),
      destination_location: attr(dst.hosting_country, [`system_inventory:${dst.system}`]),
    },
    summary: `The source environment is in ${src.hosting_country} and the receiving environment is in ${dst.hosting_country}.`,
  };
};

/** Recipient: the vendor registry relationship + processing role, mapped via the taxonomy. */
const recipientLookup: Lookup = ({ event, evidence }, cfg) => {
  const id = evidence.identity_evidence;
  if (!id || id.source_of_record !== "vendor_registry") return null;
  const rel = id.destination_relationship;
  const system = event.observed_change.destination_system;
  if (!rel || rel.system !== system) return null;

  const match = cfg.taxonomies.recipient_type.registry_mapping.find(
    (m) =>
      m.relationship_type === rel.relationship_type &&
      (!m.processing_role || m.processing_role === rel.processing_role)
  );
  if (!match) return null;

  const typeEvidence = [`vendor_registry:${system}`];
  if (evidence.technical_metadata?.destination?.system === system) {
    typeEvidence.push(`system_inventory:${system}`);
  }
  return {
    method: "authoritative_lookup",
    status: "resolved",
    attributes: {
      recipient_type: attr(match.recipient_type, typeEvidence),
      recipient_id: attr(system, [`vendor_registry:${system}`]),
    },
    summary: `${system} is operated by ${rel.organization ?? "a registered party"}, registered as a ${human(
      rel.relationship_type
    )} acting as a ${human(rel.processing_role ?? "recipient")}.`,
  };
};

const LOOKUPS: Record<string, Lookup> = {
  classification_resolver: classificationLookup,
  location_resolver: locationLookup,
  recipient_resolver: recipientLookup,
};

// ---------------------------------------------------------------------------
// Model-backed resolution (the Purpose resolver, and the fallback for others).
// ---------------------------------------------------------------------------

export function buildResolverSystemPrompt(
  contract: ResolverContract,
  cfg: StateResolutionConfig
): string {
  const outputs = Object.entries(contract.outputs).map(([name, spec]) => {
    if (spec.taxonomy) {
      const values = taxonomyValues(cfg, spec.taxonomy);
      return `  - ${name}: exactly one of [${values.join(", ")}]`;
    }
    return `  - ${name}: ${spec.type ?? "value"}`;
  });
  return [
    `You are the "${contract.name}" (id: ${contract.id}), one of four specialized`,
    `STATE RESOLVERS in a data governance system. You establish governance-relevant`,
    `FACTS: what is true now. You do not apply policy and you make no governance`,
    `judgment about whether anything is permitted.`,
    ``,
    `QUESTION: ${contract.question}`,
    ``,
    `GUARDRAILS (binding):`,
    ...contract.guardrails.map((g) => `  - ${g.trim()}`),
    ``,
    `OUTPUT ATTRIBUTES:`,
    ...outputs,
    ``,
    `RULES:`,
    `  - Use only the evidence provided. Cite evidence by its key name`,
    `    (e.g. "integration_description") or reference string.`,
    `  - confidence is 0..1 and reflects how strongly the evidence supports the value.`,
    `  - If the evidence is insufficient, set status "unresolved". If credible sources`,
    `    disagree, set status "conflicted" and list the disagreement in "conflicts".`,
    `  - "summary" is one or two sentences naming the evidence behind the value.`,
    `    Do not include step-by-step reasoning.`,
    ``,
    `OUTPUT FORMAT — return STRICT JSON only. No prose, no markdown, no code fences:`,
    `{"status": "resolved|unresolved|conflicted", "attributes": {"<attribute>": {"value": <value>, "confidence": <0..1>, "evidence": ["<ref>", ...]}}, "summary": "<1-2 sentences>", "conflicts": [{"attribute": "<name>", "evidence": ["<ref>", "<ref>"], "note": "<what disagrees>"}]}`,
  ].join("\n");
}

export function buildResolverUserMessage(
  contract: ResolverContract,
  input: ResolverInput
): string {
  return [
    "## OBSERVED EVENT",
    "```json",
    JSON.stringify(input.event, null, 2),
    "```",
    "",
    `## EVIDENCE (only the families this resolver may use: ${contract.evidence_families.join(", ")})`,
    "```json",
    JSON.stringify(scopeEvidence(contract, input.evidence), null, 2),
    "```",
  ].join("\n");
}

function parseModelDraft(raw: string): Draft {
  const obj = JSON.parse(extractJson(raw)) as Record<string, any>;
  const status = String(obj.status ?? "").toLowerCase() as ResolverStatus;
  if (!["resolved", "unresolved", "conflicted"].includes(status)) {
    throw new Error(`Invalid resolver status "${obj.status}"`);
  }
  const attributes: Record<string, ResolvedAttribute> = {};
  for (const [name, a] of Object.entries(obj.attributes ?? {})) {
    const v = a as Record<string, any>;
    attributes[name] = {
      value: v?.value,
      confidence: Number(v?.confidence),
      evidence: Array.isArray(v?.evidence) ? v.evidence.map(String) : [],
      sourceType: "model",
    };
  }
  const conflicts = Array.isArray(obj.conflicts)
    ? obj.conflicts.map((c: any) => ({
        attribute: String(c?.attribute ?? ""),
        evidence: Array.isArray(c?.evidence) ? c.evidence.map(String) : [],
        note: String(c?.note ?? ""),
      }))
    : undefined;
  return {
    method: "model",
    status,
    attributes,
    summary: String(obj.summary ?? "").trim() || "(no summary provided)",
    conflicts: conflicts?.length ? conflicts : undefined,
  };
}

async function resolveWithModel(
  contract: ResolverContract,
  input: ResolverInput,
  cfg: StateResolutionConfig,
  callModel: ModelCall
): Promise<Draft> {
  const system = buildResolverSystemPrompt(contract, cfg);
  const user = buildResolverUserMessage(contract, input);
  try {
    return parseModelDraft(await callModel({ system, user }));
  } catch {
    // One retry, as for the governance agents. Then fail, and never guess state.
    try {
      return parseModelDraft(await callModel({ system, user }));
    } catch (e) {
      return failedDraft("model", e);
    }
  }
}

function failedDraft(method: ResolutionMethod, e: unknown): Draft {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    method,
    status: "failed",
    attributes: {},
    summary: "Resolver failed technically. No state was established.",
    issues: [msg],
  };
}

// ---------------------------------------------------------------------------
// Normalization against the contract, taxonomy, and confidence threshold.
// ---------------------------------------------------------------------------

function taxonomyValues(cfg: StateResolutionConfig, name: string): string[] {
  const t = (cfg.taxonomies as unknown as Record<string, { values?: string[] }>)[name];
  return t?.values ?? [];
}

function validValue(
  spec: { type?: string; taxonomy?: string },
  value: unknown,
  cfg: StateResolutionConfig
): boolean {
  if (spec.taxonomy) return taxonomyValues(cfg, spec.taxonomy).includes(value as string);
  if (spec.type === "boolean") return typeof value === "boolean";
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Enforce the contract on a draft result. Every declared output must be
 * present, carry a valid value, and meet the confidence threshold. Otherwise the
 * resolver is "unresolved". "conflicted" and "failed" are kept as they are.
 */
export function normalizeResult(
  contract: ResolverContract,
  draft: Draft,
  cfg: StateResolutionConfig,
  resolvedAt: string
): ResolverResult {
  const issues = [...(draft.issues ?? [])];
  const attributes: Record<string, ResolvedAttribute> = {};
  const threshold = cfg.assembly.confidence_threshold;

  if (draft.status !== "failed") {
    for (const [name, spec] of Object.entries(contract.outputs)) {
      const a = draft.attributes[name];
      if (!a) {
        issues.push(`${name}: not established`);
        continue;
      }
      const confidence = Number.isFinite(a.confidence)
        ? Math.max(0, Math.min(1, a.confidence))
        : 0;
      attributes[name] = { ...a, confidence };
      if (!validValue(spec, a.value, cfg)) {
        issues.push(`${name}: value ${JSON.stringify(a.value)} is not an allowed value`);
      } else if (confidence < threshold) {
        issues.push(`${name}: confidence ${confidence.toFixed(2)} is below the ${threshold.toFixed(2)} threshold`);
      }
    }
  }

  let status = draft.status;
  if (status === "resolved" && issues.length > 0) status = "unresolved";

  return {
    resolverId: contract.id,
    resolverName: contract.name,
    method: draft.method,
    status,
    attributes,
    summary: draft.summary,
    resolvedAt,
    conflicts: draft.conflicts,
    issues: issues.length ? issues : undefined,
  };
}

// ---------------------------------------------------------------------------
// Running resolvers
// ---------------------------------------------------------------------------

/** Run one resolver: a lookup first where the contract allows it, then the model. */
export async function runResolver(
  contract: ResolverContract,
  input: ResolverInput,
  cfg: StateResolutionConfig,
  deps: ResolverDeps
): Promise<ResolverResult> {
  const now = deps.now ?? (() => new Date());
  const scoped: ResolverInput = {
    event: input.event,
    evidence: scopeEvidence(contract, input.evidence),
  };

  let draft: Draft | null = null;
  try {
    if (contract.method === "authoritative_lookup") {
      const lookup = LOOKUPS[contract.id];
      draft = lookup ? lookup(scoped, cfg) : null;
      if (!draft && !contract.model_fallback) {
        draft = {
          method: "authoritative_lookup",
          status: "unresolved",
          attributes: {},
          summary: "The authoritative source does not cover this evidence.",
        };
      }
    }
    if (!draft) draft = await resolveWithModel(contract, scoped, cfg, deps.callModel);
  } catch (e) {
    draft = failedDraft(contract.method, e);
  }

  return normalizeResult(contract, draft, cfg, now().toISOString());
}

/**
 * Run the resolvers independently and concurrently (§14). Each result is
 * reported as soon as it lands, so the audit trail shows them separately.
 */
export async function runResolvers(
  contracts: ResolverContract[],
  input: ResolverInput,
  cfg: StateResolutionConfig,
  deps: ResolverDeps,
  onResult?: (r: ResolverResult) => void | Promise<void>
): Promise<ResolverResult[]> {
  return Promise.all(
    contracts.map(async (c) => {
      const result = await runResolver(c, input, cfg, deps);
      await onResult?.(result);
      return result;
    })
  );
}

function human(s: string): string {
  return s.replace(/_/g, " ");
}
