# SETUP_GITHUB.md — Throwaway repo + scoped token

Feature 1 (the synchronous gate) opens a **real pull request** so the demo can show
an actual PR being blocked or approved. That PR is opened on a **throwaway repo**
whose only purpose is to receive these PRs — it holds nothing of value. The app
authenticates to it with a **fine-grained token scoped to that one repo only**.

> Two repos, do not confuse them:
> - **`data-governance-agent-team`** — the public CODE repo (this project). Holds
>   the app, the governed YAML, and these docs. Never holds any token.
> - **`governance-demo-prs`** — the disposable THROWAWAY repo that only receives the
>   demo's pull requests. `GITHUB_OWNER` / `GITHUB_REPO` and the scoped token point
>   HERE, not at the code repo.

Do this once, before running the app. Total time: ~5 minutes.

> Security principle: the token goes only in `.env.local` (gitignored). It must
> never appear in the public code repo. Scope it to the single throwaway repo so
> that even if it leaked, the blast radius is one disposable repository.

---

## Step 1 — Create the throwaway repo

1. Go to https://github.com/new
2. Name it something obvious, e.g. `governance-demo-prs`.
3. Set it to **Public** or **Private** — either works. Private is tidier; public
   lets article readers see the PRs the demo created.
4. Check **"Add a README file"** so the repo has an initial commit (the app needs
   a base branch to open PRs against).
5. Click **Create repository**.
6. Note the **owner** (your username or org) and the **repo name** — these become
   `GITHUB_OWNER` and `GITHUB_REPO`.

## Step 2 — Create a fine-grained personal access token

1. Go to https://github.com/settings/tokens?type=beta
   (Settings → Developer settings → Personal access tokens → Fine-grained tokens).
2. Click **Generate new token**.
3. **Token name:** `governance-demo`.
4. **Expiration:** pick a short window (e.g., 30 days). You can regenerate later.
5. **Resource owner:** your account (or the org that owns the throwaway repo).
6. **Repository access:** choose **Only select repositories**, and select **only**
   the throwaway repo from Step 1. Do not grant access to all repositories.
7. **Permissions → Repository permissions**, set exactly these (leave all others as
   "No access"):
   - **Contents:** Read and write   (create branches/commits)
   - **Pull requests:** Read and write   (open PRs, post comments)
   - **Metadata:** Read-only   (auto-selected; required)
8. Click **Generate token** and **copy it now** — GitHub shows it only once.

## Step 3 — Put the values in `.env.local`

In the project root, copy the example file and fill it in:

```bash
cp .env.local.example .env.local
```

Then edit `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...            # your Anthropic key
GITHUB_TOKEN=github_pat_...             # the fine-grained token from Step 2
GITHUB_OWNER=your-username-or-org       # from Step 1
GITHUB_REPO=governance-demo-prs         # from Step 1
```

`.env.local` is gitignored — confirm it is listed in `.gitignore` before any commit.

## Step 4 — Verify

Run the app and trigger Feature 1 with a benign edit. You should see:
- a new branch and PR appear in the throwaway repo, and
- a comment on that PR with the governance agent team's verdict.

If the GitHub variables are missing or wrong, the demo still runs end-to-end and
simply reports that the GitHub step was skipped — so you can develop and record the
agent evaluation even without the repo configured. But for the full "real PR gets
blocked" moment in the article, complete the steps above.

---

## If something goes wrong

- **403 / resource not accessible:** the token isn't scoped to this repo, or a
  permission is missing. Re-check Step 2.6 (only-select-repositories includes the
  repo) and Step 2.7 (Contents + Pull requests both Read and write).
- **404 on the repo:** `GITHUB_OWNER` / `GITHUB_REPO` don't match the actual repo,
  or the token's resource owner differs from the repo owner.
- **No base branch:** ensure the throwaway repo has at least one commit (the README
  from Step 1.4 provides it).
- **Token expired:** regenerate it (Step 2) and update `.env.local`.
