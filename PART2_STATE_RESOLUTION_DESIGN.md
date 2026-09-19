# PART2_STATE_RESOLUTION_DESIGN.md

## Data Governance Agent Team — Part 2: State Resolution

### Purpose

Extend the existing **Data Governance Agent Team** demo from Part 1 by adding an upstream **state resolution** capability.

Part 1 already demonstrates the governance control plane:

- deterministic routing through the decision-rights matrix,
- bounded governance agents,
- machine-readable policies,
- pass / block / escalate verdicts,
- human assignment when escalation is required,
- and an auditable relationship path showing how the decision was reached.

Part 2 should **not redesign or replace that architecture**.

Instead, it should answer the question Part 1 intentionally left unresolved:

> Before the decision-rights matrix can determine which governance agents should act, how does the system establish the governance-relevant state of the data?

The Part 2 implementation should add that missing upstream capability and then hand the resulting state into the existing Part 1 control plane.

---

# 1. Core Design Principle

The implementation should preserve a strict separation among three things:

## State

**What is true now?**

Examples:

- the data contains PII,
- the source is in the United States,
- the destination is in Germany,
- the recipient is an external processor,
- the purpose is marketing.

## Policy

**What must be true or what is permitted?**

Examples:

- PII transferred externally must have specific protections,
- cross-border transfers may require an approved basis,
- marketing use may require authorization.

## Governance Judgment

**Given the current state and applicable policy, what should happen?**

Possible results remain:

- PASS
- BLOCK
- ESCALATE

State resolution must **not quietly become the policy engine**.

A resolver may determine that the destination is Germany. It must not decide that a particular regulation applies.

A resolver may determine that the purpose is marketing. It must not decide whether marketing is authorized.

Those judgments remain downstream responsibilities of the existing governance agents.

---

# 2. Architectural Goal

The extended end-to-end flow should be:

```text
Continuous Collection
        |
        v
Change Awareness
        |
        v
Observed Event
        |
        v
Evidence Collection
        |
        v
+-------------------------------+
| Specialized State Resolvers   |
|                               |
| Classification Resolver       |
| Location Resolver             |
| Recipient Resolver            |
| Purpose Resolver              |
+-------------------------------+
        |
        v
State Assembler
        |
        v
Resolved Routing State
        |
        v
Prior State vs. New State
        |
        v
State Delta
        |
        v
Governance Materiality Filter
        |
        v
Existing Decision-Rights Matrix
        |
        v
Existing Governance Agent Team
        |
        v
PASS / BLOCK / ESCALATE
        |
        v
Existing Audit / Relationship Path
```

The specialized resolvers should run **in parallel where practical**.

The State Assembler and materiality filter should be **deterministic**.

The existing Part 1 governance routing and governance-agent logic should remain intact unless a very small integration change is required.

---

# 3. Scope

## In Scope

Implement exactly one end-to-end scenario:

> A U.S.-based CRM sends customer names and email addresses through an API to an external marketing SaaS platform hosted in Germany for use in outbound marketing.

The implementation must demonstrate:

1. an observed technical event,
2. evidence collection,
3. four specialized resolver agents,
4. resolver confidence and provenance,
5. deterministic state assembly,
6. deterministic derived state,
7. comparison of prior state to new state,
8. state delta,
9. deterministic materiality filtering,
10. hand-off to the existing decision-rights matrix,
11. routing to existing governance agents,
12. an ESCALATE outcome because marketing authorization cannot be established,
13. an expanded audit / relationship path showing the complete Part 2 + Part 1 chain.

## Out of Scope

Do not add:

- a new database,
- a production metadata platform,
- live catalog integration,
- live IAM integration,
- live cloud discovery,
- live contract systems,
- generalized legal reasoning,
- broad conflict-resolution workflows,
- multiple Part 2 scenarios,
- a dynamic materiality reasoning agent,
- new governance-agent roles unless absolutely necessary,
- enterprise-grade queueing or distributed orchestration,
- a redesign of the existing UI,
- a new application framework,
- a new model provider.

Use the existing repository stack and conventions as the source of truth.

---

# 4. Important Conceptual Rules

The implementation should make these ideas visible.

## 4.1 The data does not have to change for governed state to change

The customer name and email values can remain identical.

The governed state changes because the context changes:

```text
BEFORE

Customer PII
    -> internal CRM
    -> United States
    -> internal use
    -> customer service


AFTER

Customer PII
    -> external SaaS provider
    -> Germany
    -> external processing
    -> marketing
```

## 4.2 The data does not have to move for governed state to change

This principle is important to the architecture even though the first demo scenario is a movement event.

Future state changes could be caused by:

- access changes,
- purpose changes,
- structure changes,
- classification changes,
- ownership changes,
- security-condition changes.

Do not hard-code the architecture so tightly around "movement" that these future event types become impossible.

## 4.3 Observed facts are not resolved state

An event may observe:

```text
source system = CRM
destination system = CampaignCloud
fields = customer_id, full_name, email_address
integration name = crm_to_campaigncloud_contact_sync
```

That is evidence.

State resolution converts evidence into governance-relevant facts such as:

```text
contains_pii = true
origin_location = US
destination_location = Germany
recipient_type = external_processor
processing_purpose = marketing
```

## 4.4 State resolution should establish minimum routing state

Do not make state resolution answer every question the governance agents may eventually need.

State resolution should establish enough state to determine **which governance authorities need to become involved**.

The governance agents may then retrieve or consume additional **decision evidence**.

Example:

State resolution establishes:

```text
processing_purpose = marketing
```

The Policy & Jurisdiction Agent later evaluates:

```text
Is marketing an approved purpose for this data?
```

That distinction is intentional.

---

# 5. Existing Repository Preservation

Before writing code, inspect the repository and identify:

- current application structure,
- current orchestrator,
- current model-provider abstraction,
- current agent contract pattern,
- current YAML / JSON configuration patterns,
- current decision-rights matrix,
- current policy files,
- current scenario files,
- current audit/event structures,
- current relationship-path visualization,
- current tests,
- current local run instructions.

Then extend those patterns.

## Do not:

- replace working Part 1 components,
- rename core concepts without a strong reason,
- rewrite the decision-rights matrix,
- rewrite the governance agents,
- introduce a second orchestration framework,
- introduce a second model client if the current one can be reused.

## Prefer:

- additive files,
- small integration changes,
- existing configuration patterns,
- existing event structures,
- existing UI components,
- existing styling,
- existing audit conventions.

Part 1 must still work after Part 2 is implemented.

---

# 6. The Part 2 Scenario

Use a fictional destination system named **CampaignCloud** unless an existing repo convention suggests a better fictional name.

## Business Situation

A U.S.-based CRM currently stores customer information for customer-service use.

A new API integration is created that sends customer records to CampaignCloud, an external marketing SaaS provider.

The receiving CampaignCloud environment is hosted in Germany.

Transferred fields:

- `customer_id`
- `full_name`
- `email_address`

The integration is intended to support outbound marketing campaigns.

The governance system can establish that:

- the data contains personal information,
- the source is in the US,
- the destination is in Germany,
- the recipient is an external processor,
- the purpose is marketing.

The downstream governance agents can establish that:

- an approved vendor relationship exists,
- a data processing agreement exists,

but cannot establish that:

- marketing is an authorized processing purpose for this customer data.

Therefore the expected final verdict is:

```text
ESCALATE
```

The escalation should route to the existing appropriate fictional human steward, preferably the Privacy / Data Governance steward already represented by the Part 1 decision-rights model.

Do not invent a second human-assignment mechanism if one already exists.

---

# 7. Observed Event

The scenario should begin with a technical event that is intentionally incomplete.

Example:

```yaml
event_id: EVT-1001
event_type: data_movement_created

asset_id: crm.customer

observed_change:
  source_system: CRM
  destination_system: CampaignCloud
  mechanism: REST_API
  source_structure: customer
  destination_structure: campaign_contact

fields:
  - customer_id
  - full_name
  - email_address

integration:
  name: crm_to_campaigncloud_contact_sync
  description: Synchronize eligible CRM contacts for outbound campaigns
```

Do not put resolved state directly into this observed event.

For example, the event should not simply declare:

```yaml
contains_pii: true
processing_purpose: marketing
cross_border: true
```

Those conclusions should be produced by state resolution.

---

# 8. Evidence Package

Create an evidence package derived from demo configuration files.

The demo should not require live enterprise integrations.

The evidence package should support five evidence families.

## 8.1 Technical Metadata

Example:

```yaml
source:
  system: CRM
  hosting_country: US
  owner: Customer Operations

destination:
  system: CampaignCloud
  hosting_country: Germany
  owner: Marketing
  vendor_owned: true
```

## 8.2 Data Evidence

Example:

```yaml
catalog:
  CRM.customer.full_name:
    classification: PII

  CRM.customer.email_address:
    classification: PII
```

The first scenario should use authoritative existing classifications so the Classification Resolver is straightforward.

## 8.3 Relationship Evidence

Example:

```yaml
lineage:
  source: CRM.customer
  destination: CampaignCloud.campaign_contact
  transfer_type: API
```

## 8.4 Identity / Relationship Evidence

Example:

```yaml
destination_relationship:
  organization: CampaignCloud Inc.
  relationship_type: third_party_vendor
  processing_role: data_processor
```

## 8.5 Business Context

Example:

```yaml
integration_description:
  Synchronize eligible CRM contacts for outbound campaigns

destination_application_category:
  marketing_automation

destination_business_owner:
  Marketing
```

This evidence should support reasoning by the Purpose Resolver without simply declaring the answer.

---

# 9. Common Resolver Contract

Implement four specialized state resolvers.

Each resolver should have:

- a narrow responsibility,
- explicit allowed evidence,
- explicit output attributes,
- confidence,
- provenance,
- a concise explanation,
- a status.

All resolvers should conform to a common output shape.

Conceptual interface:

```ts
type ResolverStatus =
  | "resolved"
  | "unresolved"
  | "conflicted";

type ResolvedAttribute<T> = {
  value: T;
  confidence: number;
  evidence: string[];
  sourceType?: string;
};

type ResolverResult = {
  resolverName: string;
  status: ResolverStatus;
  attributes: Record<string, ResolvedAttribute<unknown>>;
  summary: string;
  resolvedAt: string;
};
```

Adapt naming to existing repository conventions.

Do not create a conflicting domain model if Part 1 already has equivalent primitives.

---

# 10. Resolver 1 — Classification Resolver

## Responsibility

Answer:

> What kind of data is this?

## Output

At minimum:

```text
contains_pii
classification
```

Expected scenario result:

```yaml
resolver: classification_resolver
status: resolved

attributes:
  contains_pii:
    value: true
    confidence: 1.00
    evidence:
      - catalog:CRM.customer.full_name
      - catalog:CRM.customer.email_address

  classification:
    value: personal_data
    confidence: 1.00
    evidence:
      - enterprise_classification_taxonomy

summary:
  Two transferred fields are authoritatively classified as PII.
```

## Allowed Evidence

- existing catalog classifications,
- glossary or classification taxonomy,
- schema metadata,
- field names,
- profiles,
- sample values,
- prior stewardship decisions.

## Guardrail

The Classification Resolver may determine that data is personal.

It must not determine whether use of that data is legally or organizationally permitted.

---

# 11. Resolver 2 — Location Resolver

## Responsibility

Answer:

> Where is the data originating and where is it going or being processed?

## Output

At minimum:

```text
origin_location
destination_location
```

Expected scenario result:

```yaml
resolver: location_resolver
status: resolved

attributes:
  origin_location:
    value: US
    confidence: 1.00
    evidence:
      - system_inventory:CRM

  destination_location:
    value: Germany
    confidence: 1.00
    evidence:
      - system_inventory:CampaignCloud

summary:
  The source environment is in the US and the receiving environment is in Germany.
```

## Allowed Evidence

- application inventory,
- cloud region metadata,
- hosting metadata,
- system configuration,
- legal-entity metadata,
- endpoint configuration.

## Guardrail

The Location Resolver establishes geographic facts.

It must not determine:

- applicable regulation,
- lawful basis,
- policy consequences.

Those remain downstream governance questions.

---

# 12. Resolver 3 — Recipient Resolver

## Responsibility

Answer:

> Who or what is receiving, accessing, or processing the data?

## Output

At minimum:

```text
recipient_type
recipient_id
```

Expected scenario result:

```yaml
resolver: recipient_resolver
status: resolved

attributes:
  recipient_type:
    value: external_processor
    confidence: 1.00
    evidence:
      - vendor_registry:CampaignCloud
      - system_inventory:CampaignCloud

  recipient_id:
    value: CampaignCloud
    confidence: 1.00
    evidence:
      - vendor_registry:CampaignCloud

summary:
  The destination is operated by a third-party vendor acting as a data processor.
```

## Suggested Recipient Types

Keep the taxonomy small.

For now support:

```text
internal_user
internal_application
external_processor
external_partner
customer
agent
unknown
```

It is acceptable if the current scenario uses only `external_processor`.

## Allowed Evidence

- IAM metadata,
- service identities,
- application ownership,
- vendor registry,
- user roles,
- contract metadata.

---

# 13. Resolver 4 — Purpose Resolver

## Responsibility

Answer:

> Why is the data being accessed, moved, or processed?

This is expected to be the most reasoning-heavy resolver.

## Output

At minimum:

```text
processing_purpose
```

Expected scenario result:

```yaml
resolver: purpose_resolver
status: resolved

attributes:
  processing_purpose:
    value: marketing
    confidence: 0.96
    evidence:
      - integration_description
      - destination_application_category
      - destination_business_owner

summary:
  The transfer is most consistent with marketing based on the campaign description, destination application category, and Marketing ownership.
```

## Allowed Evidence

- API descriptions,
- integration/job descriptions,
- workflow context,
- application function,
- process metadata,
- data contracts,
- prior stewardship decisions,
- business ownership metadata.

## Guardrail

The Purpose Resolver determines the likely purpose.

It must not determine whether that purpose is authorized.

---

# 14. Resolver Execution

Run the four resolvers in parallel where the existing application architecture permits.

Conceptually:

```text
                         +-> Classification Resolver --+
                         |                              |
Observed Event + Evidence+-> Location Resolver --------+--> State Assembler
                         |                              |
                         +-> Recipient Resolver -------+
                         |                              |
                         +-> Purpose Resolver ----------+
```

The four resolver results should be visible independently in the audit trail.

Do not hide them behind a single general-purpose state-resolution response.

---

# 15. Resolver Status

Support three statuses:

## Resolved

Sufficient evidence exists to establish the requested state.

## Unresolved

Evidence is insufficient or confidence is below the configured threshold.

## Conflicted

Credible evidence sources disagree.

Example future conflict:

```text
catalog classification = non_sensitive
content inspection = email addresses
```

Do not fully implement complex conflict-management workflows in this first increment.

It is enough to:

- represent `conflicted`,
- show it in the audit log,
- stop downstream processing,
- route to an existing or simple human-review path.

For the first scenario, all four resolvers should return `resolved`.

---

# 16. Confidence

Confidence should be stored at the **attribute level**, not only at the resolver level.

Example:

```yaml
contains_pii:
  value: true
  confidence: 1.00

classification:
  value: personal_data
  confidence: 0.97
```

Use a configurable threshold.

For the demo, a simple rule is sufficient:

```text
>= 0.90  -> acceptable as resolved
< 0.90   -> unresolved
```

If the current repo has a better threshold/configuration convention, use it.

Do not present this threshold as a governance industry standard. It is only demo configuration.

---

# 17. Provenance

Every resolved attribute should retain enough provenance to answer:

- what do we think is true?
- how confident are we?
- what evidence supported it?
- which resolver produced it?
- when was it resolved?

Minimum conceptual structure:

```text
value
confidence
evidence
resolver
resolved_at
```

The audit UI should make provenance visible without exposing hidden chain-of-thought reasoning.

Persist or display concise reasoning summaries only.

---

# 18. State Assembler

The State Assembler must be deterministic.

It should not call the LLM.

Its responsibilities are:

```text
validate
normalize
derive
compare
```

## 18.1 Validate

Confirm:

- required resolver results exist,
- required attributes are present,
- required resolver statuses are `resolved`,
- confidence thresholds are met.

If state cannot be assembled confidently, stop before governance routing.

## 18.2 Normalize

Construct a single routing-state object.

Expected scenario result:

```yaml
routing_state:
  contains_pii: true
  classification: personal_data
  origin_location: US
  destination_location: Germany
  recipient_type: external_processor
  processing_purpose: marketing
```

## 18.3 Derive

Create deterministic derived state.

Expected:

```yaml
derived_state:
  cross_border: true
  external_transfer: true
  purpose_change: true
```

Suggested logic:

```text
cross_border =
  origin_location != destination_location

external_transfer =
  recipient_type in [external_processor, external_partner]

purpose_change =
  prior_state.processing_purpose != routing_state.processing_purpose
```

No LLM should be required for these derived flags.

---

# 19. Prior State

Provide a prior governance state for the CRM data.

Example:

```yaml
prior_state:
  contains_pii: true
  classification: personal_data
  location: US
  recipient_type: internal_application
  processing_purpose: customer_service
```

Adapt the schema so prior and new state compare cleanly.

The important meaning is:

```text
BEFORE
internal US use for customer service

AFTER
external Germany use for marketing
```

---

# 20. State Delta

The State Assembler should compare prior and current state.

Expected scenario delta:

```yaml
state_delta:

  destination_location:
    prior: US
    current: Germany
    changed: true

  recipient_type:
    prior: internal_application
    current: external_processor
    changed: true

  processing_purpose:
    prior: customer_service
    current: marketing
    changed: true
```

Unchanged attributes may also be retained but should not dominate the visualization.

The UI should emphasize changed governance-relevant attributes.

---

# 21. Governance Materiality Filter

The materiality filter must be deterministic.

Its question is:

> Did anything change that could alter governance obligations?

Use configuration rather than model reasoning.

Example:

```yaml
materiality_rules:

  contains_pii:
    change_is_material: true

  classification:
    change_is_material: true

  origin_location:
    change_is_material: true

  destination_location:
    change_is_material: true

  recipient_type:
    change_is_material: true

  processing_purpose:
    change_is_material: true

  physical_server:
    change_is_material: false

  pipeline_run_id:
    change_is_material: false
```

Expected scenario result:

```yaml
governance_material_change: true

material_changes:
  - destination_location
  - recipient_type
  - processing_purpose
```

If a change is not material:

- log it,
- update appropriate technical/audit metadata,
- do not invoke the governance agent team.

This is important to prevent governance noise.

---

# 22. Hand-Off to Existing Part 1 Control Plane

After materiality is confirmed, create the compact input required by the existing decision-rights layer.

Conceptually:

```yaml
asset: CRM.customer

contains_pii: true
classification: personal_data

cross_border: true
external_transfer: true

processing_purpose: marketing

material_change: true
```

Do not replace existing Part 1 routing logic.

The existing decision-rights matrix should determine which governance agents have authority.

Expected routing should include at minimum:

- Classification & PII Agent
- Policy & Jurisdiction Agent

Use the existing Assignment & Steward behavior when escalation occurs.

If the existing matrix naturally invokes the Relationship & Lineage Agent for this scenario, preserve that behavior.

Do not force new routing solely to make the Part 2 demo look more complex.

---

# 23. Decision Evidence

State resolution establishes routing state.

Governance agents may consume additional evidence required to make the final governance decision.

Provide the Policy & Jurisdiction Agent with scenario evidence similar to:

```yaml
vendor_agreement:
  exists: true

data_processing_agreement:
  exists: true

approved_processing_purposes:
  - customer_service
  - transaction_processing

marketing_authorization:
  status: unknown
```

The important distinction is:

```text
State Resolution:
processing_purpose = marketing

Governance Judgment:
is marketing an authorized use?
```

These must remain separate.

---

# 24. Expected Final Outcome

The scenario should end in:

```text
ESCALATE
```

The reason should be concise and auditable.

Suggested user-facing explanation:

> Customer personal data is being transferred from a U.S. internal system to an external processor in Germany for a marketing purpose. An approved vendor and data processing agreement exist, but the available evidence does not establish that marketing is an authorized processing purpose for this customer data. Human review is required.

Route the escalation using the existing decision-rights / steward-assignment mechanism.

Prefer an existing Privacy / Data Governance steward role if available.

---

# 25. Audit and Relationship Path

Extend the existing audit visualization rather than replacing it.

The complete path should make the following stages visible:

```text
Observed Event
    |
    v
Evidence
    |
    +--> Classification Resolver
    |
    +--> Location Resolver
    |
    +--> Recipient Resolver
    |
    +--> Purpose Resolver
    |
    v
Resolved State
    |
    v
State Delta
    |
    v
Materiality
    |
    v
Decision-Rights Routing
    |
    v
Governance Agents
    |
    v
ESCALATE
    |
    v
Assigned Human Steward
```

The visual should make it possible to answer:

- What happened?
- What evidence was examined?
- What state was resolved?
- Which resolver established each state attribute?
- How confident was the resolver?
- What changed from the prior state?
- Why was the change considered material?
- Which governance agents were invoked?
- Which policies were evaluated?
- Why did the system escalate?
- Who owns the escalation?

Do not overload the main screen with every evidence field.

Use progressive disclosure, expandable details, tooltips, drawers, or the existing repo pattern.

---

# 26. UI Requirements

Preserve the existing visual style.

Add only what is needed to make Part 2 understandable.

The user should be able to run the scenario and see:

## Stage 1 — Event

A concise view of the new CRM -> CampaignCloud integration.

## Stage 2 — Resolver Team

Four resolvers running independently.

Show:

- name,
- status,
- resolved attributes,
- confidence.

## Stage 3 — Resolved State

Show the assembled routing state.

## Stage 4 — State Delta

Prefer a simple before / after table.

Example:

| Attribute | Previous | Current | Changed |
|---|---|---|---|
| PII | True | True | No |
| Classification | Personal | Personal | No |
| Location | US | Germany | Yes |
| Recipient | Internal | External processor | Yes |
| Purpose | Customer service | Marketing | Yes |

Visually emphasize changed rows.

## Stage 5 — Materiality

Show:

```text
Governance Material Change: YES
```

and:

- destination location,
- recipient type,
- processing purpose.

## Stage 6 — Existing Governance Control Plane

Continue into the current Part 1 visualization.

The user should experience Part 2 as an upstream extension of Part 1, not as a second application.

---

# 27. Configuration-First Design

Continue the Part 1 principle that governed logic should be legible and changeable without rewriting application code where practical.

Prefer configuration files for:

- scenario evidence,
- resolver contracts,
- resolver confidence thresholds,
- allowed classification values,
- recipient taxonomy,
- processing-purpose taxonomy,
- materiality rules,
- prior state.

Use the repository's existing YAML or JSON convention.

Do not create a second configuration philosophy.

---

# 28. Suggested New Configuration Artifacts

Actual names should follow current repository conventions.

Possible additions:

```text
state-resolution/
  resolver-contracts/
    classification.yaml
    location.yaml
    recipient.yaml
    purpose.yaml

  evidence/
    crm-campaigncloud.yaml

  prior-state/
    crm-customer.yaml

  materiality.yaml

  taxonomies/
    classification.yaml
    recipient-type.yaml
    processing-purpose.yaml
```

If the existing repository already has appropriate directories, place these there instead.

Do not create unnecessary directory depth.

---

# 29. Logging

Every Part 2 stage should emit structured audit events compatible with the existing Part 1 audit/event system.

Suggested event types:

```text
state_resolution_started

resolver_started
resolver_completed
resolver_unresolved
resolver_conflicted

state_assembled

state_delta_calculated

materiality_evaluated

state_resolution_completed

governance_handoff
```

Reuse existing event naming / typing conventions if they differ.

Each event should contain enough information to reconstruct the path without storing hidden model reasoning.

---

# 30. Error Handling

The new flow should fail safely.

## Resolver Failure

If one resolver fails technically:

- record the failure,
- do not fabricate state,
- stop before governance routing,
- surface a human-review / retry state.

## Unresolved State

If a required attribute is unresolved:

- do not continue as if the state were known,
- produce a state-resolution escalation.

## Conflicted State

If credible evidence conflicts:

- preserve both evidence references,
- mark the attribute or resolver conflicted,
- stop before the Part 1 governance judgment.

## Missing Prior State

Do not fail the scenario solely because prior state is unavailable.

If necessary:

- resolve current state,
- mark state delta as unavailable or first-observation,
- use materiality rules appropriate for a new relationship/event.

The supplied demo scenario should include prior state, so this is only defensive design.

---

# 31. Model Use

Reuse the existing model client and model configuration.

Do not add another LLM provider.

Use model reasoning only where interpretation is required.

Likely model-backed:

- Classification Resolver, when authoritative metadata is insufficient
- Location Resolver, when evidence is ambiguous
- Recipient Resolver, when organizational relationship is unclear
- Purpose Resolver, expected to use reasoning in this scenario
- existing governance agents

Deterministic:

- State Assembler
- derived-state calculations
- state comparison
- state delta
- materiality filter
- decision-rights routing

This distinction should be obvious in the code.

---

# 32. Testing Requirements

Add tests following existing repository conventions.

At minimum test:

## Resolver Unit Tests

### Classification Resolver

Given authoritative PII catalog metadata:

```text
contains_pii = true
classification = personal_data
status = resolved
```

### Location Resolver

Given source US and destination Germany:

```text
origin_location = US
destination_location = Germany
status = resolved
```

### Recipient Resolver

Given third-party vendor processor evidence:

```text
recipient_type = external_processor
status = resolved
```

### Purpose Resolver

Given campaign-sync description + marketing automation destination:

```text
processing_purpose = marketing
status = resolved
```

Because LLM output can vary, use the repository's existing model-mocking or fixture strategy if one exists.

Do not make automated tests depend on a live external model call if avoidable.

## State Assembler Tests

Confirm:

```text
cross_border = true
external_transfer = true
purpose_change = true
```

## Delta Tests

Confirm:

```text
destination_location changed
recipient_type changed
processing_purpose changed
```

## Materiality Tests

Confirm all three changes are material.

Also test a technical-only change such as:

```text
physical_server changed
```

and confirm:

```text
governance_material_change = false
```

## Integration Test

Run the complete scenario and verify:

```text
observed event
-> four resolvers
-> resolved state
-> state delta
-> materiality true
-> existing governance routing
-> final ESCALATE
```

---

# 33. Acceptance Criteria

The Part 2 implementation is complete when all of the following are true.

## Compatibility

- Existing Part 1 scenarios still run.
- Existing Part 1 routing still works.
- Existing policies and agent contracts still work.
- No unnecessary new runtime dependency was introduced.

## State Resolution

- Four specialized resolvers exist.
- They run independently / concurrently where practical.
- Each returns status, attributes, confidence, evidence, and summary.
- State resolution does not perform downstream governance judgment.

## State Assembly

- A deterministic assembler builds a routing state.
- Derived attributes are calculated deterministically.
- Prior state and current state are compared.
- A state delta is produced.

## Materiality

- Materiality is configuration-driven.
- Materiality is deterministic.
- Technical-only non-material change can bypass governance agents.

## Part 1 Integration

- Material state is handed to the existing decision-rights matrix.
- Existing governance agents are invoked.
- Existing assignment logic handles escalation.

## Scenario Outcome

The CRM -> CampaignCloud scenario must end in:

```text
ESCALATE
```

because marketing authorization cannot be established.

## Auditability

A user can trace:

```text
event
-> evidence
-> resolvers
-> resolved state
-> delta
-> materiality
-> decision rights
-> governance agents
-> escalation
-> human owner
```

---

# 34. Implementation Sequence

Implement in small increments and keep the application runnable after each step.

## Step 1 — Repository Reconnaissance

Before changing code:

1. read README,
2. read DESIGN / IMPLEMENTATION documentation,
3. identify orchestration code,
4. identify existing domain types,
5. identify model client,
6. identify config loader,
7. identify decision-rights implementation,
8. identify audit/event model,
9. identify relationship visualization,
10. identify tests.

Produce a short implementation plan before editing.

## Step 2 — Add Part 2 Domain Types

Add the minimum types for:

- evidence package,
- resolver result,
- resolved attribute,
- routing state,
- derived state,
- state delta,
- materiality result.

Reuse existing types wherever possible.

## Step 3 — Add Scenario Configuration

Add:

- observed event,
- evidence,
- prior state,
- decision evidence.

Do not change Part 1 scenarios.

## Step 4 — Implement Resolver Contract

Create the common resolver interface and shared parsing / validation.

## Step 5 — Implement Four Resolvers

Implement:

1. Classification
2. Location
3. Recipient
4. Purpose

Run concurrently if compatible with current architecture.

## Step 6 — Implement State Assembler

Deterministic only.

## Step 7 — Implement State Delta

Compare prior state to new state.

## Step 8 — Implement Materiality

Configuration-driven deterministic rules.

## Step 9 — Integrate with Existing Control Plane

Map resolved state to the existing decision-rights inputs.

Avoid changing downstream behavior unless necessary.

## Step 10 — Extend Audit Events

Record all Part 2 stages.

## Step 11 — Extend Visualization

Add Part 2 nodes/stages before the existing Part 1 relationship path.

## Step 12 — Test End to End

Verify expected ESCALATE result.

## Step 13 — Regression Test Part 1

Run every existing Part 1 scenario and confirm no regressions.

---

# 35. What Claude Code Should Not Do

Do not:

- redesign the application,
- build a generalized state-resolution platform,
- add more scenarios,
- add more resolver agents,
- add a database,
- add authentication,
- add production integrations,
- add a workflow engine,
- add vector search,
- add RAG infrastructure,
- create a legal ontology,
- create dynamic materiality reasoning,
- replace YAML / JSON configuration with hard-coded logic,
- merge all resolvers into one prompt,
- make the State Assembler an LLM agent,
- make the decision-rights matrix probabilistic,
- remove or bypass Part 1.

If implementation reveals a genuine blocker, document it before broadening scope.

---

# 36. Design Intent

The purpose of this implementation is not to prove that AI can make every governance decision.

It is to demonstrate a disciplined division of labor:

```text
Change Awareness:
Something happened.

Resolvers:
What is now true?

State Assembler:
Put those truths into a consistent state.

Materiality Filter:
Did anything governance-relevant change?

Decision-Rights Matrix:
Who has authority over this situation?

Governance Agents:
Given the policy and evidence, what should happen?

Human Steward:
Resolve the cases the machines should not.
```

The design deliberately confines probabilistic reasoning to bounded places where interpretation is required.

Everything that can reasonably remain deterministic should remain deterministic.

The Part 2 demo should make that division visible.

---

# 37. Desired Demonstration Narrative

The final demo should support this simple verbal walkthrough:

1. A new CRM-to-marketing integration appears.
2. Change awareness notices it.
3. The system gathers evidence.
4. Four specialized resolvers independently establish classification, location, recipient, and purpose.
5. The deterministic assembler creates the new governed state.
6. The system compares that state with what was true before.
7. It discovers that destination, recipient type, and purpose have materially changed.
8. The existing decision-rights matrix determines which governance agents have authority.
9. The governance agents evaluate the applicable policies and supporting decision evidence.
10. The system can establish the facts but cannot establish that marketing is an authorized purpose.
11. It escalates the decision to the appropriate human steward.
12. The entire path is replayable in the audit view.

The key message should be obvious from the running example:

> The data itself did not change. Its context changed, so its governed state changed.

And:

> State resolution determines what is happening. Deterministic routing determines who has authority. Governance agents determine whether it is permitted.

---

# 38. Deliverables

Claude Code should produce:

1. working code,
2. updated scenario/configuration files,
3. resolver contracts,
4. state assembler,
5. state delta logic,
6. materiality configuration and logic,
7. integration with the existing Part 1 control plane,
8. expanded audit events,
9. expanded relationship visualization,
10. unit tests,
11. integration test,
12. regression confirmation for Part 1,
13. README / documentation update explaining how to run the Part 2 scenario.

Do not consider the task complete until the scenario can be run from the application and visibly ends in the expected ESCALATE outcome.
