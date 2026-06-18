# IMPLEMENTATION.md — Autonomous Build Plan

**Audience:** Claude Code, building this app end-to-end with minimal back-and-forth.
**Authority:** DESIGN.md governs the "what/why"; this document governs the
"how/in-what-order." If you find a genuine conflict, follow DESIGN.md and note it
in the README. Do not introduce decisions that DESIGN.md's "Rejected alternatives"
section already ruled out.

**Operating assumptions for autonomous execution:**
- Build the milestones in order. Each milestone has explicit acceptance criteria;
  do not advance until they pass.
- Do not invent scope. If something is underspecified, choose the simplest option
  consistent with DESIGN.md and record the choice in the README's "Build notes."
- Never commit secrets. All keys come from `.env.local` (gitignored). The public
  repo must contain no key, token, or `.env` file.
- Prefer clarity over cleverness; this code is published and read by others.

---

## 1. Tech stack and versions

- **Next.js** (App Router), TypeScript, React.
- **Node** LTS.
- **YAML parsing:** `js-yaml`.
- **Anthropic SDK:** `@anthropic-ai/sdk`. Use the model string `claude-sonnet-4-6`
  for agent calls (good cost/quality for structured verdicts; the orchestration
  doesn't need Opus). Make the model a single configurable constant.
- **GitHub:** `@octokit/rest`.
- **Faker:** `@faker-js/faker`.
- **Relationship graph (M8):** `reactflow` for the node-edge path visualization.
- **Audit log store:** a local JSON file (`data/audit-log.json`) is sufficient.
  SQLite is acceptable if preferred, but JSON keeps the repo zero-setup. Pick JSON
  unless there is a concrete reason not to.
- **Styling:** the UI must look clean, professional, and enterprise-credible — this
  is recorded for a published article, so visual quality matters. Concretely:
  - Consult the frontend-design skill before building UI; follow its guidance on
    typography, spacing, and avoiding templated defaults.
  - Use a restrained, professional palette: a neutral background, one accent color,
    and clear semantic colors for the three verdicts (e.g., green=PASS,
    red=BLOCK, amber=ESCALATE) used consistently as badges.
  - Generous whitespace; a clear type hierarchy; a single sans-serif typeface.
  - The streamed log is the hero element — make agent name, verdict badge, and
    reasoning easy to scan at a glance and legible at recording resolution.
  - No heavy UI framework is required; plain React + CSS (or Tailwind if preferred)
    is fine. Avoid anything that looks like an unstyled bootstrap demo.

## 2. Repository layout

This is the public CODE repo, named **`data-governance-agent-team`**. (It is
distinct from the disposable **`governance-demo-prs`** throwaway repo that only
receives the demo's pull requests — see SETUP_GITHUB.md.)

```
governance-demo/
├── DESIGN.md
├── IMPLEMENTATION.md
├── README.md                      # build notes + how to run with your own keys
├── .env.local.example             # documents required env vars; NO real values
├── .gitignore                     # must include .env.local and data/audit-log.json
├── governance/                    # GOVERNED DATA — source of truth (already exists)
│   ├── schema.yaml
│   ├── policies.yaml
│   ├── decision_rights_matrix.yaml
│   ├── scenarios.yaml
│   └── agents/
│       ├── classification_pii.yaml
│       ├── quality.yaml
│       ├── policy_jurisdiction.yaml
│       ├── assignment_steward.yaml
│       └── relationship_lineage.yaml
├── lib/
│   ├── governance.ts              # load + parse all YAML; typed accessors
│   ├── routing.ts                 # evaluate agent_routing against a change
│   ├── agents.ts                  # build agent prompt, call Anthropic, parse verdict
│   ├── orchestrator.ts            # run the team, aggregate, emit events
│   ├── steward.ts                 # steward_resolution from the matrix
│   ├── generator.ts               # faker + custom helpers for scenarios
│   ├── github.ts                  # open PR + post verdict on throwaway repo
│   ├── graph.ts                   # M8: build relationship graph from run events
│   └── audit.ts                   # append + read audit log
├── app/
│   ├── page.tsx                   # the two-feature UI (left panel + right stream)
│   ├── api/gate/route.ts          # Feature 1: PR evaluation, SSE stream
│   ├── api/monitor/route.ts       # Feature 2: file landing, SSE stream
│   └── api/audit/route.ts         # read audit log for display
└── data/
    └── audit-log.json             # created at runtime; gitignored
```

## 3. Environment variables

Document in `.env.local.example` (no real values):
```
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=github_pat_...           # fine-grained, scoped to the throwaway repo ONLY
GITHUB_OWNER=<your-username-or-org>
GITHUB_REPO=governance-demo-prs       # the THROWAWAY repo, NOT the code repo
AGENT_MODEL=claude-sonnet-4-6         # optional override
```
The GitHub token must be **fine-grained, scoped to only the throwaway repo**, with
just the permissions needed to open a PR and post a comment/status (Contents:
read/write, Pull requests: read/write). Document this in the README.

## 4. The core data model (shared types)

Define in `lib/governance.ts`:
- `Change` — a normalized representation of what is being evaluated, used by BOTH
  features so the engine is feature-agnostic:
  ```
  Change {
    source: "gate" | "monitor"
    asset: { table?: string, scenarioId?: string, domain: string }
    state_attributes: Record<string, any>   // resolved effective attributes
    diff?: { added: Column[], altered: Column[], removed: Column[] }  // gate
    records?: Record<string, any>[]          // monitor (generated rows)
    declared: { contains_pii?: boolean }      // what the change claims
  }
  ```
- `AgentContract`, `Policy`, `MatrixRoutingRule`, `StewardRule`, `Scenario` — typed
  shapes mirroring the YAML.
- `Verdict = "PASS" | "BLOCK" | "ESCALATE"`.
- `AgentResult { agentId, verdict, reasoning, details, stewardsAssigned? }`.
- `RunEvent` — the streamed event (see §7).

## 5. Routing (`lib/routing.ts`)

Implement `selectAgents(change): agentId[]` by evaluating
`decision_rights_matrix.yaml > agent_routing` against the change's effective state:
- Derive boolean facts from the change: `contains_pii` (declared OR detected-by-state),
  `cross_jurisdictional_consumption`, `has_quality_rules` (any changed/affected
  column carries `quality_rules`), `has_foreign_key` (any changed/affected column
  has a `foreign_key`).
- A rule matches if all keys in its `when` are satisfied (`always: true` always matches).
- Union the `invoke` lists, preserving order; ensure `assignment_steward` runs LAST.
- This function is deterministic and pure — unit-testable without the LLM.

## 6. Agents (`lib/agents.ts`)

`runAgent(contract, change, governanceContext): AgentResult`:
- Build a **system prompt** from the contract: its authority, permitted_scope,
  guardrails, escalation_trigger, logging_obligation, and the allowed verdicts.
- Build a **user message** containing: the change (diff or generated records), the
  relevant schema baseline, and the relevant policies. Include only what the
  contract's `permitted_scope` allows — this keeps each agent within its authority
  and is itself a demonstrable governance property.
- Instruct the model to return **strict JSON only** (no prose, no markdown fences):
  `{ "verdict": "...", "reasoning": "...", "details": { ... } }`. Parse defensively
  (strip accidental fences; on parse failure, retry once, then treat as ESCALATE
  with a logged "unparseable verdict" reason — never silently PASS).
- Run independent agents in **parallel** (`Promise.all`) for speed; `assignment_steward`
  runs after, since it consumes the others' results.

## 7. Orchestration + streaming (`lib/orchestrator.ts`, API routes)

The orchestrator is feature-agnostic: given a `Change`, it routes, runs agents,
aggregates, assigns, logs, and emits events. API routes adapt each feature into a
`Change`, then stream.

**Streaming mechanism:** API routes return an SSE stream (`text/event-stream`).
Emit `RunEvent`s as the run progresses. Event types (minimum):
- `run_started` { change summary }
- `routing` { agentsSelected, the matrix rules that matched }  ← shows routing visibly
- `agent_started` { agentId, one_liner }
- `agent_result` { agentId, verdict, reasoning }
- `assignment` { stewards by dimension, any coverage gap }
- `team_verdict` { verdict }
- `github` { prUrl, prState }            ← Feature 1 only
- `audit_written` { auditId }
- `run_complete`

**Team verdict aggregation (exact rule):** if any agent returned BLOCK → `BLOCK`;
else if any returned ESCALATE → `ESCALATE`; else `PASS`. `assignment_steward` never
contributes a BLOCK. On ESCALATE or BLOCK-needing-an-owner, include the assigned
stewards in the result.

**Concurrency note:** run independent agents in parallel (`Promise.all`) so a run
finishes quickly. The app runs locally and is single-user, so there are no
concurrency or scaling concerns — parallelism here is purely for responsiveness on
the recording.

## 8. Steward resolution (`lib/steward.ts`)

`resolveStewards(change): { byDimension, crossBorder?, coverageGap? }` from
`decision_rights_matrix.yaml > steward_resolution`:
- Match the most specific `rules` entry by the change's state.
- If `cross_jurisdictional_consumption` is true, also include `cross_border_review`
  stewards (book scenario #5).
- If no eligible steward resolves for a required dimension → `coverageGap = true`,
  fall back to `governance_lead`, and surface the gap (book scenario #3).

## 9. Generator (`lib/generator.ts`)

Implement the `scenarios.yaml` generator namespace:
- `faker.<provider>` → call the real Faker provider by name.
- Custom helpers:
  - `custom.pattern` → fill `#`→digit, `?`→letter from the `pattern` string.
  - `custom.contact_sentence` → a sentence with a real-looking email and/or phone
    embedded (this is what creates the *undeclared* PII the Classification agent
    must catch in `support_export_hidden_pii`).
  - `custom.fixed` → return `value`.
  - `custom.choice` → random pick from `options`.
- Generate N rows (default ~10). Honor `constraint:` only as metadata passed to
  agents (the generator does not need to enforce quality rules — the Quality agent
  evaluates them; for the BLOCK-by-bad-data path, optionally allow a scenario to
  request a deliberately invalid value, but this is not required for v1's three
  scenarios).
- Support output framing as JSON and CSV (the "other" option may map to JSON).

## 10. GitHub integration (`lib/github.ts`) — Feature 1 only

- Create a branch on the throwaway repo, commit the proposed schema change as a
  file diff (e.g., write the edited `schema.yaml` or a migration file), open a PR.
- Post the team verdict as a PR comment (and optionally a commit status):
  PASS → comment "approved by governance agent team" ; BLOCK → comment with the
  blocking agents and reasons, leave PR open/failed ; ESCALATE → comment naming the
  assigned stewards, leave PR open with a `needs-human-review` label.
- All GitHub calls use `GITHUB_TOKEN` scoped to the throwaway repo. Fail gracefully
  with a clear message if GitHub env vars are absent, so the rest of the demo still
  runs (useful for readers without a throwaway repo).

## 11. Audit log (`lib/audit.ts`)

- `appendAudit(entry)` and `readAudit()`. Entry:
  `{ id, timestamp, source, asset, agentResults[], teamVerdict, stewards }`.
- Persist to `data/audit-log.json` (gitignored). `app/api/audit/route.ts` serves it
  for the UI panel. The audit log is shown at the end of each run and as a running
  history — this is the "auditable trail" credibility point.

## 12. UI (`app/page.tsx`)

- **Left panel:** render the five agent contracts (from the loaded YAML) summarized
  to authority / guardrails / escalation / logs, plus the active policies. Read from
  the same governance loader the engine uses — never hardcode.
- **Right region — Feature 1:** show the two tables (`customers`, `orders`) from
  `schema.yaml`; let the user add/alter/remove a column or constraint; a Commit
  button calls `/api/gate` and renders the SSE event stream as a readable log,
  ending with the team verdict, the PR link, and the audit entry.
- **Right region — Feature 2:** a scenario picker (the three scenarios), a format
  picker (JSON/CSV/other), a "simulate file landing" button calling `/api/monitor`,
  rendering the same streamed log + verdict + audit entry, and showing the generated
  data so the viewer sees what the agents evaluated.
- Make the streamed log visually clear (agent name, verdict badge, reasoning). This
  is the artifact people screenshot; it should read well on a recording.

## 13. Milestones and acceptance criteria

Build in order. Do not advance until acceptance passes.

- **M0 — Project init.** Next.js + TS app scaffolds and runs; deps installed;
  `.gitignore`, `.env.local.example`, README skeleton in place.
  *Accept:* `npm run dev` serves an empty page; no secrets committed.

- **M1 — Governance loader.** `lib/governance.ts` loads and types all YAML.
  *Accept:* a script/log prints the five contracts, policies, matrix, scenarios
  correctly parsed.

- **M2 — Routing.** `lib/routing.ts` selects agents from the matrix.
  *Accept:* unit checks — a PII customer change selects classification_pii +
  policy_jurisdiction (+ assignment last); an orders quality change selects quality
  + relationship_lineage (+ assignment).

- **M3 — Single agent call.** `lib/agents.ts` runs one agent against a change and
  returns a parsed verdict from a real Anthropic call.
  *Accept:* Classification agent BLOCKs a customers change that adds undeclared PII
  with no policy; PASSes a benign change. JSON parsed reliably.

- **M4 — Full orchestration (no UI).** `lib/orchestrator.ts` runs the team in
  parallel, aggregates the team verdict, runs assignment, writes audit.
  *Accept:* the three monitor scenarios produce PASS / BLOCK / ESCALATE
  respectively when run headless; audit entries written.

- **M5 — Streaming UI.** API routes stream `RunEvent`s; `page.tsx` renders the
  left panel and the right stream for Feature 2.
  *Accept:* clicking a scenario streams routing → agents → verdict → audit live in
  the browser; all three scenarios show their engineered verdict.

- **M6 — Feature 1 with real GitHub PR.** Table editor → `/api/gate` → agents →
  real PR on the throwaway repo with the verdict posted.
  *Accept:* a PII-adding edit opens a real PR and posts a BLOCK with reasons; a
  benign edit posts a PASS. Absent GitHub env vars, the run still completes and
  says GitHub was skipped.

- **M7 — Polish + audit panel + README.** Audit history panel; clean styling for
  recording; README explains the thesis briefly, how to run with your own keys, the
  throwaway-repo token scoping, and states plainly that this is an illustrative
  reference implementation, not production.
  *Accept:* a full run of both features records cleanly end-to-end; repo is
  publishable with no secrets.

- **M8 — Relationship graph (post-M7 enhancement).** A visual node-edge graph of
  the path each request took through the governed data. Builds live during a run
  and is saved with each audit entry for replay. Full spec in §15.
  *Accept:* running any request renders a graph whose path matches that run's
  events; invoked agents are colored by verdict and un-invoked agents are grayed;
  the matrix edge that triggered each agent is labeled; opening a past audit entry
  re-renders its graph.

## 14. Definition of done

- Both features run locally and record cleanly, showing PASS, BLOCK, and ESCALATE.
- Routing is visibly matrix-driven; agents are real LLM calls; verdicts are logged;
  a real PR is opened and annotated.
- The repo is public-ready: no secrets, clear README, governed data readable as
  files, DESIGN.md and IMPLEMENTATION.md included.

---

## 15. Relationship graph (M8) — full specification

### 15.1 Purpose
Visualize the **relationship path** each request takes through the governed data —
the connective tissue between asset, state, agents, policies, and outcome. This
makes two otherwise-invisible properties legible: (1) routing is matrix-driven and
selective (some agents fire, others are deliberately excluded), and (2) every
verdict has a traceable path, which is the Relationship Model's reason for existing
(auditing and traceability). The graph is a second view over data already produced
by the run; it requires no new backend logic.

### 15.2 Node-and-edge model
A request renders as a left-to-right flow across five node columns:

1. **Origin** — the request/asset. One node.
   - Gate: the table + the changed column(s) (e.g., "customers + national_id").
   - Monitor: the scenario (e.g., "support export").
2. **State attributes** — the effective attributes the router actually read
   (e.g., `contains_pii=true`, `cross_jurisdictional_consumption=true`,
   `declared_pii=false`). One node per attribute that participated in routing.
3. **Agents** — one node per agent in the roster. Invoked agents are active and
   colored by their own verdict; **un-invoked agents are rendered grayed/dashed**
   to show the matrix narrowed the team. Assignment agent always present.
4. **Policies** — one node per policy an invoked agent evaluated against
   (e.g., `pii_protection`, `usage_policy`, `cross_border`).
5. **Outcome** — the team verdict node (PASS/BLOCK/ESCALATE) and, on ESCALATE
   (or BLOCK needing an owner), the resolved **steward** node(s).

**Edges (the path):**
- Origin → State attribute: "this asset has this attribute."
- State attribute → Agent: labeled with the matrix rule that matched
  (e.g., `matched: contains_pii`). This is the visual proof that routing came from
  `decision_rights_matrix.yaml`, not from arbitrary code.
- Agent → Policy: "this agent evaluated this policy."
- Policy → Outcome (or Agent → Outcome): the contribution to the verdict.
- Outcome(ESCALATE) → Steward: the resolved owner from `steward_resolution`.

### 15.3 Visual encoding
- **Verdict color** applied consistently to nodes and the edges along their path:
  green = PASS, red = BLOCK, amber = ESCALATE (same semantic palette as the rest
  of the UI, §1 Styling).
- **Un-invoked agents:** gray fill, dashed border, no outgoing edges.
- **Edge labels:** the matrix rule on state→agent edges; the policy clause on
  policy→outcome edges where space allows.
- **The blocking/escalating path is emphasized** (thicker or glowing edge) so the
  "why" is followable at a glance on a recording.

### 15.4 Data source — derive from existing RunEvents
No new orchestrator logic. Build the graph from the `RunEvent` stream (§7):
- `routing` → the agents selected (active) vs. the full roster (the rest grayed),
  plus the matched matrix rules → state-attribute nodes and their edge labels.
- `agent_result` → each invoked agent's verdict (node color) and the policies it
  evaluated (from the agent's `details`) → policy nodes and agent→policy edges.
- `assignment` → steward nodes and outcome→steward edges; any coverage gap shown.
- `team_verdict` → the outcome node and the emphasized path color.

Add a small pure builder, `lib/graph.ts: buildGraph(runEvents | auditEntry):
{ nodes, edges }`, returning a serializable graph used by both the live and the
saved-replay views. Persist the built graph (or enough to rebuild it) on the audit
entry so historical runs replay identically.

### 15.5 Rendering
- Use **React Flow** (`reactflow`). It handles the columnar left-to-right layout,
  per-node styling, edge labels, and is recording-friendly.
- Provide a simple deterministic layout: fixed x-position per column (origin →
  state → agents → policies → outcome), y-position distributed within each column.
  Do not require a physics/force layout — a tidy, stable arrangement records better.
- **Live mode:** subscribe to the same SSE stream as the log; add nodes/edges as
  events arrive so the path draws itself during the run (place this beside or below
  the streaming log so the two reinforce each other).
- **Replay mode:** each audit-history entry is clickable and re-renders its saved
  graph. This is the on-thesis view — every governed decision reopenable as its
  traceable path.

### 15.6 Acceptance criteria (restated)
- The three monitor scenarios each render a graph whose path matches their events:
  clean PASS (green, full benign path), hidden-PII BLOCK (red path through
  Classification → pii_protection → BLOCK; Quality and Lineage grayed), and
  EU-marketing ESCALATE (amber path through Policy & Jurisdiction → cross_border →
  ESCALATE → Privacy Steward + DPO).
- Un-invoked agents are visibly grayed in every run.
- State→agent edges are labeled with the matched matrix rule.
- Opening a past audit entry re-renders its graph identically to the live run.
- Renders cleanly at recording resolution.
