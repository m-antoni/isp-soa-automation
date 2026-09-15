# isp-soa-automation

Serverless pipeline that automatically retrieves your Converge ICT Statement of Account (SOA), unlocks the password-protected PDF, stages it in S3, and prepares it for email delivery.

Built with the AWS Serverless Application Model (SAM):

- **Lambda** (`isp-soa-automation`) — Node.js 22 runtime, source in `src/`
- **S3 bucket** — private, SSE-S3 encrypted, versioned, 30-day expiration for staging SOA PDFs
- Deployable via SAM CLI or GitHub Actions

**Disclaimer:** This repository is for educational and portfolio demonstration purposes only. It demonstrates serverless architecture, event-driven pipelines, and PDF manipulation on AWS. The author is not affiliated with Converge ICT. Use at your own risk in compliance with the service provider's Terms of Service.

## Project Structure

```
.
├── .github/workflows/                    # GitHub Actions
│   ├── ci.yml                            # Reusable CI quality gates, called by the two workflows below
│   ├── deploy-dev.yml                    # CI → deploy to dev on push to `dev` (notifies on Telegram)
│   └── approve-merge-to-master.yml       # CI → Telegram approve-to-merge for PRs to `master`
├── .github/secrets-manifest.txt          # Allowlisted secrets.NAMEs used in workflows
├── .github/vars-manifest.txt             # Allowlisted vars.NAMEs used in workflows
├── docs/                                 # Setup guides
│   ├── github_actions.md                 # All workflows explained
│   ├── telegram-approval.md              # Telegram bot + approve-to-merge setup
│   └── google-oauth-setup.md             # Gmail OAuth2 client + refresh token
├── src/                                  # Lambda function source (ESM, Node 22)
│   ├── index.mjs                         # Handler entry point (index.handler)
│   ├── gmail.mjs                         # Gmail OAuth2 + OTP retrieval
│   ├── helpers.mjs                       # Pure helpers (no env/network dependencies)
│   ├── helpers.test.mjs                  # Vitest unit tests for helpers
│   ├── local.mjs                         # Local-only runner (loads .env, prints result)
│   └── package.json                      # Lambda runtime dependencies
├── events/event.json                     # Sample payload for local invocation
├── template.yaml                         # SAM / CloudFormation infrastructure
├── samconfig.toml                        # Local deploy defaults (gitignored, personal values)
└── samconfig.toml.example                # Committable template; copy to samconfig.toml
```

## Lambda Dependencies (`src/package.json`)

These are the runtime packages bundled with the function. `sam build` installs them from `src/package.json` into the deployment package.

| Package                   | Purpose                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `@aws-sdk/client-s3`      | Uploads the unlocked SOA PDF to the staging bucket (`PutObjectCommand`).                          |
| `nodemailer`              | Sends the SOA email with the PDF attachment via Gmail SMTP (`smtp.gmail.com:465`).                |
| `@neslinesli93/qpdf-wasm` | qpdf compiled to WebAssembly; decrypts the password-protected SOA PDF (`--password=X --decrypt`). |
| `pdf-lib`                 | Validates the decrypted PDF (parses it back) after unlocking.                                     |

Why Gmail SMTP and not AWS SES? SES cannot legitimately send from a `@gmail.com`
address: Google's SPF/DKIM/DMARC records only authorize Google's own servers to
send as Gmail, so an email claiming to be from `@gmail.com` over SES fails all
three checks and is flagged as spam. Using `nodemailer` against Gmail SMTP goes
out through Google's servers as the real account, so it lands in the inbox.
It only needs an App Password (never the Gmail account password).

Why not `pdf-lib` for unlocking? pdf-lib cannot decrypt password-protected PDFs at
all; it throws `EncryptedPDFError` for any encrypted document, regardless of the
password. `@neslinesli93/qpdf-wasm` handles real decryption (RC4, AES-128 and
AES-256) and leaves the PDF content streams intact.

## Environment Variables

The Lambda reads these from its runtime environment (`process.env`). Values are supplied at deploy time via CloudFormation `--parameter-overrides`.

| Environment Variables     | Description                                                 | Required |
| ------------------------- | ----------------------------------------------------------- | -------- |
| `USER_EMAIL`              | Email address the unlocked SOA is sent to                   | ✓        |
| `USER_MOBILE`             | Registered mobile number used for OTP                       | ✓        |
| `CONVERGE_API_URL`        | Base URL of the Converge SOA API                            | ✓        |
| `SOA_BUCKET_NAME`         | S3 bucket where downloaded SOA PDFs go                      | ✓        |
| `PDF_PASSWORD`            | Password that unlocks the SOA PDF                           | ✓        |
| `CONVERGE_ACCOUNT_NO`     | Converge account number for the SOA flow                    | ✓        |
| `GMAIL_CLIENT_ID`         | Google OAuth2 client ID for the Gmail API                   | ✓        |
| `GMAIL_CLIENT_SECRET`     | Google OAuth2 client secret                                 | ✓        |
| `GMAIL_REFRESH_TOKEN`     | Offline refresh token for Gmail API access                  | ✓        |
| `MAIL_FROM`               | Gmail sender account (sends via Gmail SMTP)                 | ✓        |
| `MAIL_TO`                 | Recipient(s) for the SOA PDF (comma-separated for multiple) | ✓        |
| `GMAIL_SMTP_APP_PASSWORD` | Gmail App Password for `MAIL_FROM`                          | ✓        |

## Deploy Parameters

CloudFormation parameters you pass on deploy (mapped to the function env in `template.yaml`):

| Parameter           | Default                                          | Notes                               |
| ------------------- | ------------------------------------------------ | ----------------------------------- |
| `Environment`       | `dev`                                            | `dev` / `prod` (used for tags)      |
| `Runtime`           | `nodejs22.x`                                     |                                     |
| `Handler`           | `index.handler`                                  |                                     |
| `CodeUri`           | `./src`                                          |                                     |
| `UserEmail`         | —                                                | NoEcho (secret), required           |
| `UserMobile`        | —                                                | NoEcho (secret), required           |
| `PdfPassword`       | —                                                | NoEcho (secret), required           |
| `ConvergeAccountNo` | —                                                | Required                            |
| `ConvergeApiUrl`    | `https://get-soa.convergeict.com/api/v1/account` |                                     |
| `SoaBucketName`     | —                                                | Must be globally unique             |
| `GmailClientId`     | —                                                | Google OAuth2 client ID             |
| `GmailClientSecret` | —                                                | NoEcho (secret), required           |
| `GmailRefreshToken` | —                                                | NoEcho (secret), required           |
| `MailFrom`          | `michaelantoni.tech@gmail.com`                   | Gmail sender account                |
| `MailTo`            | `michaelantoni.tech@gmail.com`                   | Recipient(s), comma-separated       |
| `GmailAppPassword`  | —                                                | NoEcho (secret), Gmail App Password |

## Emailing the SOA PDF (Gmail SMTP)

The unlocked PDF is emailed by the Lambda itself using **nodemailer** against
**Gmail SMTP** (`smtp.gmail.com:465`) with the PDF attached. Mail goes out through
Google's own servers as the `MAIL_FROM` Gmail account, so SPF/DKIM/DMARC all pass
and it lands in the inbox (using SES to send from a `@gmail.com` address causes
spam-filtering).

Setup:

1. **Enable 2-Step Verification** on the `MAIL_FROM` Gmail account.
2. Create an **App Password**: Google Account → Security → App Passwords →
   generate one (16 characters, spaces are ignored).
3. Put it in the GitHub secret `GMAIL_SMTP_APP_PASSWORD` (and in
   `samconfig.toml` → `GmailAppPassword` for local deploys).
4. `MAIL_FROM` secret and `MAIL_TO` var/param control sender and recipient.

Scheduled EventBridge rules trigger the whole pipeline automatically; the
GitHub Actions CI runs on every push first, and a successful CI run for a push
to `dev` then deploys and notifies on Telegram on success:

- `isp-soa-automation-monthly` — 25th of each month (00:00 UTC).
- `isp-soa-automation-email` — **removed** (was a daily-midnight test rule).

The Lambda can also be invoked manually anytime from the AWS Console **Test** tab.

## Prerequisites

- AWS CLI (`aws configure`)
- AWS SAM CLI
- Node.js 22 (for local testing)

## Google OAuth 2.0 & Refresh Token Setup

Guide for setting up Google OAuth 2.0 credentials and generating a long-lived `REFRESH_TOKEN` for programmatic Gmail access. The Lambda uses it to read the Converge OTP from your inbox.

See **[docs/google-oauth-setup.md](docs/google-oauth-setup.md)** for the full
step-by-step (Google Cloud Console credentials, refresh token via the OAuth
Playground, and where to store the 3 Gmail secrets).

## Configuration

Copy the template and fill in your values:

```bash
# Windows (PowerShell / cmd)
copy samconfig.toml.example samconfig.toml

# macOS / Linux
cp samconfig.toml.example samconfig.toml
```

Then edit `samconfig.toml` — replace `YOUR_EMAIL`, `YOUR_MOBILE`, and `YOUR_SAM_PACKAGING_BUCKET_NAME` with your real values. `samconfig.toml` is gitignored (it contains personal data), while the `.example` is safe to commit.

## S3 Buckets

Two buckets are involved:

1. **SAM packaging bucket** — created once by hand, before `sam deploy`:

   ```bash
   aws s3 mb s3://isp-soa-automation-sam-packaging-ap-southeast-1 --region ap-southeast-1
   ```

   Then set that name in `samconfig.toml` (`s3_bucket = "..."` with `resolve_s3 = false`).

2. **SOA PDF bucket** — created automatically by the CloudFormation stack from the `SoaBucketName` parameter during deployment. Do **not** create it manually; the stack owns and configures it (SSE-S3 encryption, versioning, 30-day lifecycle).

## Deployment

### Manual deploy

```bash
# 1. Build the Lambda package (installs dependencies in src/)
sam build

# 2. Deploy (creates or updates the stack, values from samconfig.toml)
sam deploy
```

`sam deploy` reads all settings from `samconfig.toml` (stack name, region, packaging bucket, parameters). For repeatable/CI deploys, pass overrides directly:

```bash
sam deploy \
  --stack-name isp-soa-automation \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    "Environment=dev UserEmail=you@example.com UserMobile=09xxxxxxxxx \
     ConvergeApiUrl=https://get-soa.convergeict.com/api/v1/account \
     SoaBucketName=isp-soa-automation-dev-123456789012"
```

Keep `samconfig.toml`, `.env`, and secrets out of version control (already handled in `.gitignore`).

## Testing & Quality Gates

### Unit tests (Vitest)

Pure helper functions in `src/helpers.mjs` are covered by Vitest tests (`src/helpers.test.mjs`). They have no environment, network, or AWS dependencies, so they run instantly and offline:

```bash
cd src
npm ci
npm test
```

SAM strips devDependencies (including Vitest) during `sam build`, so these stay out of the Lambda deployment package.

### CI & pipeline workflows (`.github/workflows/ci.yml`)

CI is a single **[reusable workflow](docs/github_actions.md)** called by both
pipeline workflows, so every gate runs in exactly one place:

- **`deploy-dev`** (`deploy-dev.yml`) — runs on every push to `dev`; executes CI,
  then deploys to the dev environment, then notifies on Telegram.
- **`approve-merge-to-master`** (`approve-merge-to-master.yml`) — runs on PRs to
  `master`; executes CI, then Telegram-DMs for approval, then merges with a merge
  commit and notifies. The `dev` branch is kept after merging. No CI runs on
  master pushes — master only changes via the approval flow, which re-runs
  checks before merging.

Gates:

| Step                           | What it does                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Validate secrets/vars          | Fails if any `secrets.*`/`vars.*` used in a workflow isn't in `.github/secrets-manifest.txt` / `.github/vars-manifest.txt` |
| `actionlint`                   | Lints all GitHub Actions workflow YAML files                                                                               |
| gitleaks                       | Scans full git history for leaked secrets                                                                                  |
| codespell                      | Spell-checks all source/docs files                                                                                         |
| `sam validate --lint`          | Validates `template.yaml`                                                                                                  |
| `npm test`                     | Runs the Vitest unit test suite                                                                                            |
| `npm audit --audit-level=high` | Fails on high/critical CVEs                                                                                                |

Details for all workflows (orders, triggers, secrets used): **[docs/github_actions.md](docs/github_actions.md)**.

## Local testing

### Quick run (no Docker)

Loads `.env` from the project root and invokes the handler directly.

```bash
# From the src/ directory
npm run local
```

This reads `.env`, runs the full handler (OTP → download → decrypt → upload → email),
and prints the result. While the handler awaits network calls (the OTP email can
take ~60s), a `Working...` spinner is shown on stderr so the terminal doesn't just
hang; the success response is pretty-printed as JSON.

`local.mjs` is a thin local-only wrapper: it loads `.env`, invokes
`index.handler`, and prints the outcome. Nothing here runs in production.

**Sample output (success):** the `body` is parsed and pretty-printed as JSON:

```json
{
  "statusCode": 200,
  "body": {
    "status": "Success",
    "message": "ISP SOA Automation Trigger Success.",
    "otp": "U6AC8T",
    "s3": "soa/1464602714620/2026-09/SOA-2026-09-30.pdf",
    "file_name": "SOA-2026-09-30.pdf",
    "email_sent_from": "michaelantoni.tech@gmail.com",
    "email_sent_to": ["michaelantoni.tech@gmail.com", "m.antoni@accenture.com"],
    "timestamp": "2026-09-14T07:01:30.292Z"
  }
}
```

**Sample output (failure):** the invocation exits non-zero with the last error:

```text
HANDLER FAILED: OTP validation failed for all candidates. Failed OTPs: [{"otp":"R2SJ2B","error":"validation rejected"}]
```

### SAM local invoke (Docker required)

```bash
sam local invoke SoaAutomationFunction -e events/event.json \
  --parameter-overrides \
    "UserEmail=test@example.com UserMobile=09000000000 \
     ConvergeApiUrl=https://get-soa.convergeict.com/api/v1/account \
     SoaBucketName=isp-soa-automation-dev-local"
```

## Telegram Approve-to-Merge Workflow (PRs to `master`)

`.github/workflows/approve-merge-to-master.yml` lets you approve PRs to `master` from
your phone: the workflow runs after a **successful CI run** on a `dev → master` PR,
DMs you on Telegram, you reply `yes`/`no`, and it runs checks then auto-merges
(or rejects).

> **Note:** merges use a merge commit and **keep `dev`** (no `--delete-branch`). To
> sync `dev` with any master-only changes, merge master down occasionally:
>
> ```bash
> git checkout dev && git merge origin/master
> git push origin dev
> ```

Full setup guide including how to get the Telegram token, the GitHub token, and
the 3 secrets: **[docs/telegram-approval.md](docs/telegram-approval.md)**

## Cleanup

```bash
sam delete --stack-name isp-soa-automation
```

---

### Author

**Michael B. Antoni**

- **Email:** michaelantoni.tech@gmail.com
- **LinkedIn:** [https://linkedin.com/in/m-antoni](https://linkedin.com/in/m-antoni)
