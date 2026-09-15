# GitHub Actions Workflows

This repository uses three GitHub Actions workflows. This page explains what each one does, when it triggers, and what secrets/values it needs.

## Overview

| Workflow | File | Purpose |
| -------- | ---- | ------- |
| CI | `.github/workflows/ci.yml` | Quality gates on every push/PR |
| deploy-dev | `.github/workflows/deploy-dev.yml` | Deploy the stack to the dev environment on pushes to `dev` |
| approve-merge-to-master | `.github/workflows/approve-merge-to-master.yml` | Telegram bot asks you to approve a PR to `master`, then runs checks and auto-merges |

Secrets live in GitHub **environments**, not at the repo level. The `deploy-dev` job uses the `development` environment; the `approve-merge-to-master` jobs use the `production` environment. A job must declare `environment: <name>` for `secrets.*` and `vars.*` to resolve — without it, they come back empty.

---

## 1. CI (`.github/workflows/ci.yml`)

**Triggers:** every push to any branch and every pull request. (Docs are *not* skipped — a push that only changes `.md` docs still runs CI so gitleaks scans for secrets in them.)

**What it does:**

| Step | Purpose |
| ---- | ------- |
| `actions/checkout` | Checks out the code, full history (`fetch-depth: 0`) so gitleaks can scan every commit |
| Validate secrets/vars references | Fails the run if any `secrets.*` / `vars.*` used in a workflow is missing from `.github/secrets-manifest.txt` / `.github/vars-manifest.txt` |
| `rhysd/actionlint` | Lints all workflow YAML files (catches syntax errors, schema violations, bad expressions) |
| gitleaks (v8.30.1) | Scans full git history for leaked secrets — any finding fails the run |
| `actions/setup-python` (3.12) | Installs Python only to run the spell checker; not part of the Lambda runtime |
| codespell | Spell-checks all source/docs files, skipping `node_modules`, lockfiles and `.git` |
| `aws-actions/setup-sam` | Installs the SAM CLI |
| `sam validate --lint` | Validates `template.yaml` against the SAM/CloudFormation schema |
| `actions/setup-node` (22) | Installs Node.js 22 (same runtime as the Lambda) |
| `npm ci` + `npm test` | Installs dependencies from the lockfile and runs the Vitest unit suite (`src/helpers.test.mjs`) |
| `npm audit --audit-level=high` | Fails the run if any dependency has a high/critical CVE |

**Concurrency:** `ci-${{ github.ref }}` with `cancel-in-progress: true` — a newer run on the same branch cancels any older, still-running run (e.g. rapid successive pushes only test the latest commit).

**Permissions:** `contents: read` (least privilege; it never writes).

---

## 2. deploy-dev (`.github/workflows/deploy-dev.yml`)

**Triggers:** every push to the `dev` branch, plus manual `workflow_dispatch` from the Actions tab.

**Environment:** `development` (all env-scoped secrets/vars come from there).

**What it does:**

1. **Checkout** — pulls the pushed commit.
2. **Wait for CI to pass** — on pushes only (not `workflow_dispatch`), polls the `CI` workflow run for the same commit until it completes; if CI fails, the deploy aborts. Uses `gh run list` with `GITHUB_TOKEN` (workflow permission `actions: read`). Timeout after 90 attempts (15 min).
3. **Configure AWS credentials** — `configure-aws-credentials` using `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` secrets into region `vars.AWS_REGION`.
4. **Set up SAM CLI** — installs `sam`.
5. **Build Lambda** — `sam build` installs production dependencies from `src/package.json` and packages the function.
6. **Deploy stack** — `sam deploy` creates/updates the `isp-soa-automation` CloudFormation stack, passing every Lambda environment value as `--parameter-overrides`.

There is also a **`notify` job** (`needs: deploy`, `if: success()`) that sends a Telegram success message (branch, author, repo link, pipeline link) using the `production` environment's `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

**Values used:**

| Type | Names |
| ---- | ----- |
| Secrets | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `USER_EMAIL`, `USER_MOBILE`, `PDF_PASSWORD`, `CONVERGE_ACCOUNT_NO`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `MAIL_FROM`, `GMAIL_SMTP_APP_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Vars | `AWS_REGION`, `CONVERGE_API_URL`, `SOA_BUCKET_NAME`, `MAIL_TO`, `SAM_PACKAGING_BUCKET` |

**Permissions:** `actions: read` (so the CI-wait step can poll `gh run list`).

**Concurrency:** `deploy-dev` with `cancel-in-progress: true` — only one deploy runs at a time; a newer push to `dev` supersedes a still-running deploy.

---

## 3. approve-merge-to-master (`.github/workflows/approve-merge-to-master.yml`)

**Triggers:**

- a `pull_request` **opened** targeting `master` (only on open, not on later commits), e.g. `dev → master`
- manual `workflow_dispatch` (useful for testing the bot flow without opening a PR)

**Environment:** `production` (all three jobs declare it so `TELEGRAM_*` / `GH_BOT_TOKEN` secrets resolve).

**How it works — three chained jobs:**

```text
notify ──────────► wait-for-approval ──────────► merge
DMs you on        polls your Telegram reply       runs checks,
Telegram                     │                    audits, then
                             │ yes                merges the PR
                             ▼
                    (invalid reply → bot nudges you)
```

**Job 1 — `notify`:**
Sends a Telegram message with the PR number, title and URL: "Reply YES to run checks and merge, or NO to reject." Validates the bot token (logs length/prefix/suffix for diagnostics) and fails if `sendMessage` does not return `ok: true`. Outputs `notified_at` (unix timestamp of the sent message).

**Job 2 — `wait-for-approval`:**
Long-polls the bot's `getUpdates` endpoint (20 s timeout per request) with an `offset` cursor, filtering for a message in your chat that arrived **after** `notified_at` (so a "yes" left over from a previous run can't accidentally approve). `timeout-minutes: 30` caps the wait.

- reply starting with `y`/`yes`/`approve` → outputs `approved=yes`, proceeds to merge
- reply starting with `n`/`no`/`reject` → exits non-zero (run fails, nothing merges)
- anything else → the bot replies "Only YES or NO is acceptable…" and keeps polling

**Job 3 — `merge`** (runs only if `approved == 'yes'`):
1. Checks out `master`, sets up Node 22.
2. **Run checks** — `npm ci` + `npm test` (Vitest suite).
3. **Audit dependencies** — `npm audit --audit-level=high`.
4. **Merge PR** — `gh pr merge <number> --rebase --delete-branch` using `GH_BOT_TOKEN`.

**Job 4 — `notify-success`** (`needs: merge`, runs only if the merge job actually succeeded): sends a Telegram success message (branch `master`, author, repo link, pipeline link) using `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

**Values used (secrets, in `production` environment):**

| Secret | Purpose |
| ------ | ------- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for sending/polling |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID (where the DMs arrive) |
| `GH_BOT_TOKEN` | GitHub personal access token used to merge (needs `Pull requests: Read and write` **and** `Contents: Read and write`) |

**Concurrency:** `approve-master-${{ github.event.number || github.run_id }}` — one approval flow per PR (or per manual dispatch) at a time.

> Setup for the bot, token and secrets: see [telegram-approval.md](telegram-approval.md).

---

## How they fit together

```
 push to dev ──────────► CI ──► deploy-dev
 push to a branch ─────► CI
 PR dev → master ──────► CI ──► approve-merge-to-master
```

CI runs on everything and is the fast feedback loop; the Telegram workflow is the human gate before anything lands on `master`.