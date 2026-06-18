/**
 * github.ts — open a real PR on the THROWAWAY repo and post the team's verdict
 * (IMPLEMENTATION.md §10, SETUP_GITHUB.md). Feature 1 only.
 *
 * All calls use GITHUB_TOKEN, which must be fine-grained and scoped to the
 * throwaway repo only. If the GitHub env vars are absent, every function fails
 * gracefully so the rest of the demo still runs.
 */

import { Octokit } from "@octokit/rest";
import yaml from "js-yaml";
import {
  AgentResult,
  Column,
  StewardAssignment,
  Verdict,
} from "./governance";
import { GithubOutcome } from "./orchestrator";
import { flattenStewards } from "./steward";

export function isGithubConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_TOKEN &&
      process.env.GITHUB_OWNER &&
      process.env.GITHUB_REPO
  );
}

interface OpenPrArgs {
  tableName: string;
  summary: string;
  diff: { added: Column[]; altered: Column[]; removed: Column[] };
  nextColumns: Column[];
  teamVerdict: Verdict;
  agentResults: AgentResult[];
  assignment: StewardAssignment;
}

const LABELS: Record<Verdict, string | null> = {
  PASS: "governance-passed",
  BLOCK: "governance-blocked",
  ESCALATE: "needs-human-review",
};

/**
 * Create a branch, commit the proposed change as a file, open a PR, and post the
 * verdict as a comment + label. Returns a GithubOutcome (never throws).
 */
export async function openGovernancePr(
  args: OpenPrArgs
): Promise<GithubOutcome> {
  if (!isGithubConfigured()) {
    return {
      skipped: true,
      message:
        "GitHub not configured (GITHUB_TOKEN/OWNER/REPO absent) — PR step skipped. See SETUP_GITHUB.md.",
    };
  }

  const owner = process.env.GITHUB_OWNER!;
  const repo = process.env.GITHUB_REPO!;
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  try {
    // 1. Resolve the default branch and its head commit.
    const repoInfo = await octokit.repos.get({ owner, repo });
    const base = repoInfo.data.default_branch;
    const baseRef = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${base}`,
    });
    const baseSha = baseRef.data.object.sha;

    // 2. Create a fresh branch for this proposal.
    const slug = `${args.tableName}-${shortId()}`;
    const branch = `governance-demo/${slug}`;
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });

    // 3. Commit the proposed change as a readable file (a real PR diff).
    const filePath = `proposals/${slug}.yaml`;
    const fileContent = buildProposalFile(args);
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: `Propose schema change to ${args.tableName} (${args.summary})`,
      content: Buffer.from(fileContent, "utf8").toString("base64"),
      branch,
    });

    // 4. Open the PR.
    const pr = await octokit.pulls.create({
      owner,
      repo,
      head: branch,
      base,
      title: `[${args.teamVerdict}] Schema change to ${args.tableName}`,
      body: buildPrBody(args),
    });
    const prNumber = pr.data.number;
    const prUrl = pr.data.html_url;

    // 5. Post the verdict as a comment.
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: buildVerdictComment(args),
    });

    // 6. Label by verdict (best-effort — create label if missing).
    const label = LABELS[args.teamVerdict];
    if (label) {
      await ensureLabel(octokit, owner, repo, label, args.teamVerdict);
      await octokit.issues
        .addLabels({ owner, repo, issue_number: prNumber, labels: [label] })
        .catch(() => undefined);
    }

    const prState =
      args.teamVerdict === "PASS"
        ? "open (approved)"
        : args.teamVerdict === "BLOCK"
        ? "open (blocked)"
        : "open (needs human review)";

    return { prUrl, prState, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      skipped: true,
      message: `GitHub step failed (${message}). The evaluation still completed; see SETUP_GITHUB.md for token scoping.`,
    };
  }
}

// --- Content builders -------------------------------------------------------

function buildProposalFile(args: OpenPrArgs): string {
  const doc = {
    proposed_change: {
      table: args.tableName,
      summary: args.summary,
      diff: {
        added: args.diff.added.map((c) => c.name),
        altered: args.diff.altered.map((c) => c.name),
        removed: args.diff.removed.map((c) => c.name),
      },
    },
    proposed_next_columns: args.nextColumns,
    governance_team_verdict: args.teamVerdict,
  };
  return (
    "# Proposed by the Data Governance Agent Team demo.\n" +
    "# This file represents a proposed change under review.\n\n" +
    yaml.dump(doc, { lineWidth: 100 })
  );
}

function verdictEmoji(v: Verdict): string {
  return v === "PASS" ? "✅" : v === "BLOCK" ? "⛔" : "⚠️";
}

function buildPrBody(args: OpenPrArgs): string {
  const lines: string[] = [];
  lines.push(
    `## Governance agent team verdict: ${verdictEmoji(args.teamVerdict)} **${args.teamVerdict}**`,
    "",
    `**Change:** ${args.summary}`,
    "",
    "### Diff",
    diffMarkdown(args.diff),
    "",
    "### Agent verdicts",
  );
  for (const r of args.agentResults) {
    lines.push(`- ${verdictEmoji(r.verdict)} **${r.agentName}** — ${r.verdict}: ${r.reasoning}`);
  }
  lines.push("", verdictFooter(args));
  lines.push(
    "",
    "---",
    "_Opened by the Data Governance Agent Team demo — an illustrative reference implementation, not a production system._"
  );
  return lines.join("\n");
}

function buildVerdictComment(args: OpenPrArgs): string {
  if (args.teamVerdict === "PASS") {
    return `${verdictEmoji("PASS")} **Approved by the governance agent team.** All routed agents passed; no human review required.`;
  }
  const lines: string[] = [];
  if (args.teamVerdict === "BLOCK") {
    lines.push(`${verdictEmoji("BLOCK")} **Blocked by the governance agent team.**`, "", "Blocking agents:");
    for (const r of args.agentResults.filter((r) => r.verdict === "BLOCK")) {
      lines.push(`- **${r.agentName}** — ${r.reasoning}`);
    }
  } else {
    lines.push(
      `${verdictEmoji("ESCALATE")} **Escalated for human review.**`,
      "",
      "Escalating agents:"
    );
    for (const r of args.agentResults.filter((r) => r.verdict === "ESCALATE")) {
      lines.push(`- **${r.agentName}** — ${r.reasoning}`);
    }
    lines.push("", verdictFooter(args));
  }
  return lines.join("\n");
}

function verdictFooter(args: OpenPrArgs): string {
  if (args.teamVerdict !== "ESCALATE") return "";
  const stewards = flattenStewards(args.assignment);
  if (!stewards.length) return "";
  return ["### Assigned stewards", ...stewards.map((s) => `- ${s}`)].join("\n");
}

function diffMarkdown(diff: OpenPrArgs["diff"]): string {
  const rows: string[] = [];
  for (const c of diff.added) rows.push(`+ add \`${c.name}\` (${c.type})`);
  for (const c of diff.altered) rows.push(`~ alter \`${c.name}\``);
  for (const c of diff.removed) rows.push(`- remove \`${c.name}\``);
  return rows.length ? "```diff\n" + rows.join("\n") + "\n```" : "_(no changes)_";
}

async function ensureLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  name: string,
  verdict: Verdict
): Promise<void> {
  const color =
    verdict === "PASS" ? "1f8a4c" : verdict === "BLOCK" ? "c0392b" : "b5790b";
  await octokit.issues
    .createLabel({ owner, repo, name, color })
    .catch(() => undefined); // already exists — fine.
}

function shortId(): string {
  return (
    Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6)
  );
}
