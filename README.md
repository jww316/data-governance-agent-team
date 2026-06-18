# Data Governance Agent Team

> **An illustrative reference implementation — not a production system.**

A working, recorded demonstration that in an AI-native enterprise, **governance is
an operational control plane, not advisory committee work**. A team of five LLM
agents — each bound by a declarative YAML **contract** — evaluates proposed and
incoming data changes against policy and reaches defensible verdicts:

- **PASS** the routine majority (the ~80%),
- **BLOCK** policy / quality / lineage violations, and
- **ESCALATE** genuine judgment calls to named human stewards (the ~20%).

The routing that decides *which* agents fire is **deterministic** (driven by a
decision-rights matrix); only the agents' *judgment* is autonomous. That line —
deterministic control plane, autonomous judgment — is the thesis.

See [`DESIGN.md`](./DESIGN.md) for the "what & why" and
[`IMPLEMENTATION.md`](./IMPLEMENTATION.md) for the build plan.

---

## The two features

**Feature 1 — synchronous gate (PR evaluation).** View the two governed tables,
edit a column or constraint, and commit. The change is diffed against the schema
baseline, routed to the applicable agents, and a **real pull request** is opened on
a throwaway GitHub repo with the team's verdict posted as a comment. A BLOCK leaves
the PR open and flagged; a PASS marks it approved.

**Feature 2 — asynchronous monitor (file landing).** Pick a scenario and a format,
and simulate a file landing outside git. Data is generated within the scenario's
boundary (Faker + custom helpers), the agents evaluate it, and the run streams to a
verdict. The three scenarios are engineered to reliably show PASS, BLOCK, and the
on-thesis ESCALATE (EU data, marketing use, no consent).

Both features stream their run live (Server-Sent Events) and append to a local
**audit log** — the auditable trail.

## The governed data (the source of truth)

Everything the engine enforces lives as declarative YAML under
[`governance/`](./governance), so a reader sees "governance as data" without
running anything:

| File | What it holds |
|------|---------------|
| `schema.yaml` | The two governed tables and their Ch.20 state attributes. |
| `agents/*.yaml` | The five agent contracts (authority / scope / guardrails / escalation / logging / verdicts). |
| `policies.yaml` | PII, cross-border, retention, and quality policies the agents enforce. |
| `decision_rights_matrix.yaml` | Agent routing + steward resolution. |
| `scenarios.yaml` | The three file-landing templates for Feature 2. |

The engine **reads** these files; it never hardcodes their content.

## How to run (with your own keys)

```bash
npm install
cp .env.local.example .env.local     # then fill in your keys
npm run dev                          # serves http://localhost:3000
```

`.env.local` is gitignored and must never be committed.

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | yes | Powers the real LLM agent calls. |
| `GITHUB_TOKEN` | Feature 1 only | Fine-grained token scoped to the throwaway repo only. |
| `GITHUB_OWNER` / `GITHUB_REPO` | Feature 1 only | The throwaway repo that receives demo PRs. |
| `AGENT_MODEL` | no | Overrides the agent model (default `claude-sonnet-4-6`). |

If the GitHub variables are absent, the demo still runs end-to-end and simply
reports that the GitHub step was skipped — so you can develop and record the agent
evaluation without a throwaway repo.

### GitHub token scoping (important)

Feature 1 opens a real PR. The token must be **fine-grained and scoped to only the
throwaway repo** (`governance-demo-prs`), with **Contents: read/write** and
**Pull requests: read/write**. It goes only in `.env.local`. Scoping it to one
disposable repo means that even if it leaked, the blast radius is one throwaway
repository. Full walkthrough: [`SETUP_GITHUB.md`](./SETUP_GITHUB.md).

> Two repos, do not confuse them:
> - **`data-governance-agent-team`** — this public CODE repo. Never holds a token.
> - **`governance-demo-prs`** — the disposable THROWAWAY repo the demo opens PRs on.

## Verifying each milestone

Standalone scripts exercise the engine without the UI:

```bash
npm run check:governance     # M1 — all YAML parses
npm run check:routing        # M2 — routing is matrix-driven (no API key needed)
npm run check:agent          # M3 — a single real agent call BLOCKs / PASSes
npm run check:orchestrator   # M4 — three scenarios produce PASS / BLOCK / ESCALATE
```

`check:agent` and `check:orchestrator` make real Anthropic calls, so they need
`ANTHROPIC_API_KEY` in `.env.local`.

## Architecture

```
governance/            governed data (YAML, source of truth)
lib/
  governance.ts        load + parse all YAML; shared types
  routing.ts           deterministic agent routing from the matrix
  agents.ts            build prompt from contract, call Anthropic, parse verdict
  steward.ts           deterministic steward resolution from the matrix
  orchestrator.ts      route → run agents in parallel → aggregate → assign → audit
  generator.ts         Faker + custom helpers for scenario data
  github.ts            open the real PR + post the verdict (Feature 1)
  audit.ts             append + read the audit log (data/audit-log.json)
  adapters.ts          turn each feature's input into a shared Change
  sse.ts               Server-Sent Events helper
app/
  page.tsx             server component; loads the governance view
  components/          the two-feature UI (left definitions, right execution)
  api/gate|monitor|audit/route.ts   the streaming endpoints
```

The **orchestrator is feature-agnostic**: it operates on a normalized `Change`, so
the same engine powers both the gate and the monitor. Independent agents run in
parallel (`Promise.all`); the assignment agent runs last because it consumes the
others' verdicts. Team verdict aggregation: any **BLOCK** → BLOCK; else any
**ESCALATE** → ESCALATE; else **PASS**.

## Build notes

Decisions made during the autonomous build, per IMPLEMENTATION.md §13:

- **Stack:** Next.js (App Router) + TypeScript, scaffolded manually for a clean,
  dependency-minimal tree. Styling is plain CSS with a small design-token system
  (no UI framework), per IMPLEMENTATION.md §1.
- **Audit store:** local `data/audit-log.json` (gitignored), per §11 — zero-setup,
  no hosted database (a rejected alternative in DESIGN.md §9).
- **Faker provider names:** `scenarios.yaml` uses Python-Faker-style provider names
  (`faker.email`, `faker.pydecimal`, …). Since this app uses the JavaScript port
  (`@faker-js/faker`), `lib/generator.ts` maps each provider name to the real
  faker-js call. These remain real Faker calls — only the port differs.
- **YAML fix:** `agents/classification_pii.yaml` had a `: ` (colon-space) inside a
  multi-line plain scalar, which is invalid YAML and failed to parse. Reworded
  minimally (`policies.yaml: pii_protection` → `policies.yaml, section
  pii_protection`) with no change of meaning.
- **Steward resolution** is computed deterministically from the matrix
  (`lib/steward.ts`); the assignment agent is given that resolution and confirms /
  narrates it, so the steward *names* come from the matrix and are never invented by
  the model (DESIGN.md §10 — names are illustrative placeholders).
- **`declared.contains_pii` semantics:** the agent prompt clarifies that this flag
  describes only whether *the change* introduces new PII — it is not a
  re-classification of the existing asset. Without that note, the Classification
  agent read `declared.contains_pii: false` on a PII-bearing table as an attempt to
  strip protection and blocked benign edits.
- **`ownerRequired`:** a human owner (and therefore a coverage-gap escalation) is
  required only when some agent actually blocked or escalated — not merely because
  an asset is consumed cross-border in an already-approved way. Otherwise every
  routine edit to a cross-jurisdictional table would escalate and never PASS.

### Conflicts reconciled (per IMPLEMENTATION.md's "follow DESIGN.md on conflict")

- **`eu_marketing_no_consent` → ESCALATE, not BLOCK.** DESIGN.md §3 engineers this
  scenario as the on-thesis ESCALATE (the book's cross-border judgment call), but
  `policies.yaml` originally said "EU marketing without consent = BLOCK," and the
  agent faithfully blocked. Following DESIGN.md, the governed data was reconciled so
  the verdict matches the intent, while keeping the agents real (not scripted):
  - `policies.yaml > cross_border` now states an explicit **precedence**: a *novel*
    cross-border transfer (a new consuming geo not covered by an approved
    sharing_policy) combined with an open lawful-basis question is a human judgment
    call → **ESCALATE**; a missing lawful basis on an *already-approved* transfer
    remains a **BLOCK**. The `policy_jurisdiction` contract guardrail mirrors this.
  - The `eu_marketing_no_consent` scenario's `state_attributes` were made to carry
    what its own prose already describes: the PII is properly declared and
    classified (`security_classification: Confidential`, protective policies
    attached — so the Classification dimension passes and the escalation is purely
    jurisdictional), and the US marketing transfer is explicitly **novel**
    (`new_consuming_geo: US`, `transfer_covered_by_sharing_policy: false`).

## Honesty constraints

- This is an **illustrative reference implementation, not a production system.**
- The agents are **real LLM calls** — no scripted logic is presented as model
  reasoning.
- The PR is **real** on a throwaway repo; nothing here implies production
  branch-protection enforcement beyond what is actually wired.
- Steward names are **illustrative placeholders.**
