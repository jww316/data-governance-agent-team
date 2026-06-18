# DESIGN.md — Data Governance Agent Team Demo

**Status:** Locked. This document is the authoritative "what and why." Do not
re-litigate decisions recorded here during the build. Where a decision had real
alternatives, they are listed under "Rejected alternatives" with the reason, so
the build does not drift back toward them.

---

## 1. Purpose

A working, recorded demonstration that supports a TDAN column on defining and
operating a **data governance agent team**. The demo makes an invisible idea
visible: that in an AI-native enterprise, governance is an **operational control
plane**, not advisory committee work. A team of LLM agents, each bound by a
declarative contract, evaluates proposed and incoming data changes against
policy and reaches defensible verdicts — passing the routine majority, blocking
violations, and escalating genuine judgment calls to named human stewards.

The demo is the article's evidence. It is **recorded, not publicly served**. The
code is published to a public GitHub repo so readers can inspect and run it with
their own keys.

## 2. Thesis and its mapping to the source material

The demo operationalizes ideas from the author's two books:

- **Governance as control plane** — "When agents execute business processes
  autonomously, governance is no longer advisory — it is operational." The
  gate's "cannot merge until agents pass" is this made literal.
- **The agent contract** — from the order-to-cash example: an agent is
  *authorized* to examine certain things, *permitted* to retrieve certain data,
  given *guardrails*, given an *escalation* condition, and *always logs its
  decision rationale*. Every agent in this demo follows that exact shape.
- **The decision-rights matrix (Ch.20)** — the intersection of roles, assets,
  and asset states. Here it does two jobs: routing which agents fire, and
  resolving which human steward owns an outcome across the compliance,
  technical, and business dimensions.
- **The 80/20 split (Ch.19)** — ~80% of governance tasks are routine and
  agent-resolvable; ~20% require human judgment. The three verdicts
  (PASS / BLOCK / ESCALATE) and the scenarios are built around this.
- **Synchronous gate vs. asynchronous monitor** — the gate catches changes that
  flow through git; the monitor catches changes that arrive outside it (files
  landing, vendor changes, manual edits). The demo shows both.

## 3. What the demo does — two features

### Feature 1 — Synchronous gate (PR evaluation)
The user views two governed tables, edits something (e.g., adds a `national_id`
column to `customers`, or drops a NOT NULL constraint on `orders`), and clicks
commit. The app:
1. Computes the change as a diff against the schema baseline.
2. Consults the decision-rights matrix to route the change to the applicable agents.
3. Runs those agents (real LLM calls), streaming each invocation and verdict.
4. Opens a **real pull request** on a throwaway GitHub repo and posts the team's
   verdict; a BLOCK leaves the PR failed/open, a PASS marks it mergeable.
5. Writes every verdict to the audit log.

### Feature 2 — Asynchronous monitor (file landing)
The user picks a scenario and a format (JSON / CSV / other) and clicks to
simulate a file landing in the environment. The app:
1. Generates data within the scenario's boundary (faker + custom helpers).
2. Routes to the applicable agents and runs them, streaming results.
3. Reaches the scenario's engineered verdict (PASS / BLOCK / ESCALATE).
4. Writes to the audit log.

The three scenarios are engineered so the recording reliably shows all three
verdicts, including the on-thesis ESCALATE (EU data, marketing use, no consent).

## 4. The agent team (five agents)

| Agent | Role type | Blocks? | Core job |
|-------|-----------|---------|----------|
| Classification & PII | agent-only | yes | Detect PII; enforce classification + required protective policy |
| Data Quality | agent-only | yes | Validate constraints and quality rules; block degradation |
| Policy & Jurisdiction | hybrid | yes | Security/sharing/retention + cross-border; escalates judgment calls |
| Assignment & Steward | agent-only | no (routes) | Resolve the responsible human(s) from the matrix |
| Relationship & Lineage | agent-only | yes | Foreign-key/lineage impact; inherited sensitivity |

Each agent is defined by a YAML contract: `authority`, `permitted_scope`,
`guardrails`, `escalation_trigger`, `logging_obligation`, `verdicts`. The contract
is loaded and supplied to the model as the agent's system prompt. **Agents'
judgments are autonomous; the routing that invokes them is deterministic.** That
distinction is deliberate and is a point the column makes — governance is exactly
where you want the control plane bounded, not emergent.

## 5. Governed data (already built — the starting commit)

Lives as declarative YAML under `governance/` so a reader sees the "governance as
data" thesis without running anything:
- `schema.yaml` — the two tables and their Ch.20 state attributes.
- `agents/*.yaml` — the five agent contracts.
- `policies.yaml` — what agents enforce (PII, cross-border, retention, quality, 80/20).
- `decision_rights_matrix.yaml` — agent routing + steward resolution.
- `scenarios.yaml` — three file-landing templates (generator namespace:
  `faker.*` = real Faker; `custom.*` = helpers defined in generator code).

These files are the source of truth. The engine reads them; it does not hardcode
their content.

## 6. Verdict model

Three verdicts, never just pass/fail:
- **PASS** — routine; proceeds with no human involvement (the 80%).
- **BLOCK** — a policy/quality/lineage violation; the gate holds, rationale logged.
- **ESCALATE** — genuine judgment (jurisdiction, novel category, material blast
  radius); the Assignment agent names the human steward(s) and attaches context.

A team verdict aggregates agent verdicts: any BLOCK → team BLOCK; else any
ESCALATE → team ESCALATE; else PASS. (Precise rule restated in IMPLEMENTATION.md.)

## 7. UI shape

Two-region layout, the column rendered as an interface:
- **Left panel (definitions):** the agent roster with each contract summarized
  (authority / guardrails / escalation / logs), and the active policies. This is
  the *definition* the viewer reads.
- **Right region (execution):** the live streaming log of a run — each agent
  invoked, its reasoning summary, its verdict — followed by the team verdict and,
  at the end, the **audit log** (timestamped record of who decided what and why).

Definition on the left, execution on the right: the viewer sees the governed
definition and watches it execute against it.

## 8. Stack (locked)

- **Runtime:** local Next.js app on `localhost`; recorded, not deployed.
- **Governed data:** YAML files (above).
- **Agents:** real calls to the Anthropic API, one per invoked agent, contract as
  system prompt, structured verdict returned and parsed.
- **Streaming:** Server-Sent Events from a Next.js API route; the route narrates
  orchestration progress and verdicts. (Per-token streaming of agent reasoning is
  NOT done in v1 — agents run to completion, then a clean block is emitted.)
- **GitHub:** real PR opened on a throwaway repo via the GitHub API.
- **Audit log:** appended to a local store (JSON or SQLite file) and displayed.
- **Data generation:** Faker plus four custom helpers (`pattern`,
  `contact_sentence`, `fixed`, `choice`).

## 9. Rejected alternatives (do not revisit)

- **Claude Code subagents as the deployed runtime** — rejected. Claude Code is a
  terminal/CI developer tool; it cannot be the runtime behind a clickable web
  feature. Agents are app-orchestrated Anthropic API calls. (Claude Code IS used
  to *build* the app — a separate concern.)
- **Public, clickable URL** — rejected. A public button over paid API calls
  forces rate-limiting, spend caps, abuse hardening, and months of uptime, and a
  leaked key risk. The article needs a recording + public code, not a live URL.
- **Hosted database (Supabase/Postgres)** — rejected as unnecessary for a
  recorded single-user demo; adds an account and a secret to leak. YAML for
  governed data + a local file for the audit log is sufficient and more on-thesis.
- **Emergent agent-to-agent orchestration** — rejected. Routing must be
  deterministic (matrix-driven); only agent *judgment* is autonomous. Emergent
  routing would undercut the control-plane thesis.
- **Per-token streaming of every agent in v1** — deferred. Adds noise and
  complexity; the orchestration narration carries the live feel.

## 10. Honesty constraints (for credibility)

- The demo is an **illustrative reference implementation, not a production
  system** — state this plainly in the column and the repo README.
- Agents are **real LLM calls**; do not present scripted logic as model reasoning.
- The PR is **real** on a throwaway repo; do not imply production branch-protection
  enforcement beyond what is actually wired.
- Steward names are **illustrative placeholders**.
