# GitHub Actions Workflows

This repository uses two pipeline workflows (`deploy-dev`, `approve-merge-to-master`) plus one reusable workflow (`ci`) that both of them call. This page explains what each one does, when it triggers, and what secrets/values it needs.

## Overview

| Workflow | File | Purpose |
| -------- | ---- | ------- |
| CI (reusable) | `.github/workflows/ci.yml` | The 7 quality gates — single source of truth, called via `uses: ./.github/workflows/ci.yml` |
| deploy-dev | `.github/workflows/deploy-dev.yml` | CI → deploy to dev on pushes to `dev`; notifies on Telegram |
| approve-merge-to-master | `.github/workflows/approve-merge-to-master.yml` | CI → Telegram approval gate → auto-merge PRs to `master` |

Secrets live in GitHub **environments**, not at the repo level. The `deploy` job uses the `development` environment; the `notify` / approval jobs use the `production` environment. A job must declare `environment: <name>` for `secrets.*` and `vars.*` to resolve — without it, they come back empty.

> **Same-repo reusable references** (`uses: ./.github/workflows/ci.yml`) resolve at the **caller's commit**, not the default branch. Combined with the plain `push` / `pull_request` triggers, everything is **self-activating**: the moment these files land on a branch, that branch's flows work — no `workflow_run`, no "must be merged to master first" step.

---

## 1. CI — reusable workflow (`.github/workflows/ci.yml`)

Declared with `on: workflow_call` and no other trigger. It runs a single `check` job of seven gates:

| Step | Purpose |
| ---- | ------- |
| `actions/checkout` | Checks out the caller's code, full history (`fetch-depth: 0`) so gitleaks can scan every commit |
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

**Permissions:** `contents: read` (least privilege; it never writes). It uses no secrets, so callers don't need `secrets: inherit`.

The checks run even when a push only changes `.md` docs, so gitleaks still scans for secrets in them.

---

## 2. deploy-dev (`.github/workflows/deploy-dev.yml`)

**Triggers:**
- `push` to the `dev` branch
- manual `workflow_dispatch` from the Actions tab

**Concurrency:** `deploy-dev` with `cancel-in-progress: true` — only one deploy runs at a time; a newer push to `dev` supersedes a still-running deploy.

**Env-scoped values:** `deploy` uses `development`; `notify` uses `production` (Telegram).

**What it does:**

1. **`ci` job** — `uses: ./.github/workflows/ci.yml` (the seven gates). `deploy` never starts unless `needs.ci.result == 'success'`.
2. **Checkout** — pulls the code (needs `contents: read`).
3. **Configure AWS credentials** — `configure-aws-credentials` using `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` secrets into region `vars.AWS_REGION`.
4. **Set up SAM CLI** — installs `sam`.
5. **Build Lambda** — `sam build` installs production dependencies from `src/package.json` and packages the function.
6. **Deploy stack** — `sam deploy` creates/updates the `isp-soa-automation` CloudFormation stack, passing every Lambda environment value as `--parameter-overrides`.
7. **`notify` job** (`needs: deploy`, `if: needs.deploy.result == 'success'`) — Telegram success message (branch, author, repo link, pipeline link) using the `production` environment's `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

**Values used:**

| Type | Names |
| ---- | ----- |
| Secrets | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `USER_EMAIL`, `USER_MOBILE`, `PDF_PASSWORD`, `CONVERGE_ACCOUNT_NO`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `MAIL_FROM`, `GMAIL_SMTP_APP_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Vars | `AWS_REGION`, `CONVERGE_API_URL`, `SOA_BUCKET_NAME`, `MAIL_TO`, `SAM_PACKAGING_BUCKET` |

**Permissions:** `contents: read`.

---

## 3. approve-merge-to-master (`.github/workflows/approve-merge-to-master.yml`)

**Triggers:**
- `pull_request` targeting `master` (+ manual `workflow_dispatch` for testing the bot flow without opening a PR)

**Concurrency:** `approve-master-${{ github.event.pull_request.number || github.run_id }}` — one approval flow per PR (or per manual dispatch) at a time.

**Environment:** `production` (all jobs declare it so `TELEGRAM_*` / `GH_BOT_TOKEN` secrets resolve).

**How it works — five chained jobs:**

```text
ci ──► notify ──────────► wait-for-approval ──────────► merge ──► notify-success
gates    DMs you on        polls your Telegram reply     merge       Telegram
         Telegram                    │                   commit      success msg
                                     │ yes
                                     ▼
                     (invalid reply → bot nudges you)
```

**Job 1 — `ci`:** `uses: ./.github/workflows/ci.yml` (the seven gates). The DM only goes out after every gate passes — CI first, approval second.

**Job 2 — `notify`:** Sends a Telegram message with the PR number, title and URL: "Reply YES to run checks and merge, or NO to reject." The PR number comes from `github.event.pull_request.number` (with a `gh pr list` fallback for `workflow_dispatch` runs), then details are fetched with `gh pr view`. Validates the bot token (logs length/prefix/suffix for diagnostics) and fails if `sendMessage` does not return `ok: true`. Outputs `notified_at` (unix timestamp of the sent message) and `pr`.

**Job 3 — `wait-for-approval`:** Long-polls the bot's `getUpdates` endpoint (20 s timeout per request) with an `offset` cursor, filtering for a message in your chat that arrived **after** `notified_at` (so a "yes" left over from a previous run can't accidentally approve). `timeout-minutes: 30` caps the wait.

- reply starting with `y`/`yes`/`approve` → outputs `approved=yes`, proceeds to merge
- reply starting with `n`/`no`/`reject` → exits non-zero (run fails, nothing merges)
- anything else → the bot replies "Only YES or NO is acceptable…" and keeps polling

**Job 4 — `merge`** (runs only if `approved == 'yes'`):
1. Checks out `master`, sets up Node 22.
2. **Run checks** — `npm ci` + `npm test` (Vitest suite).
3. **Audit dependencies** — `npm audit --audit-level=high`.
4. **Merge PR** — `gh pr merge <number> --merge` using `GH_BOT_TOKEN` (merge commit; **keeps the `dev` branch**).

**Job 5 — `notify-success`** (`needs: merge`, runs only if the merge job actually succeeded): sends a Telegram success message (branch `master`, author, repo link, pipeline link) using `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

**Values used (secrets, in `production` environment):**

| Secret | Purpose |
| ------ | ------- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for sending/polling |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID (where the DMs arrive) |
| `GH_BOT_TOKEN` | GitHub personal access token used to merge (needs `Pull requests: Read and write` **and** `Contents: Read and write`) |

**Permissions:** `contents: read`, `pull-requests: read` (the merge uses `GH_BOT_TOKEN`, not the default `GITHUB_TOKEN`).

> Setup for the bot, token and secrets: see [telegram-approval.md](telegram-approval.md).

---

## How they fit together

```
 push to dev ──────► deploy-dev (ci → deploy → notify)
 PR dev → master ──► approve-merge-to-master (ci → notify → wait → merge → notify-success)
```

`deploy-dev` is the fast feedback loop for dev pushes and the gate ahead of deploys; `approve-merge-to-master` runs the same gates, then adds the Telegram human gate before anything lands on `master`.

> **After an approved merge:** the merge uses a **merge commit** and keeps `dev`
> on GitHub. To bring any master-only changes into `dev` (a "sync down"), run:
>
> ```bash
> git checkout dev && git merge origin/master
> git push origin dev
> ```
>
> Conflicts only appear when master's changes and dev's own work touch the same
> lines — resolve them as usual, then push.