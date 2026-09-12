# isp-soa-automation

Serverless pipeline that automatically retrieves your Converge ICT Statement of Account (SOA), unlocks the password-protected PDF, stages it in S3, and prepares it for email delivery.

Built with the AWS Serverless Application Model (SAM):

- **Lambda** (`isp-soa-automation`) — Node.js 22 runtime, source in `src/`
- **S3 bucket** — private, SSE-S3 encrypted, versioned, 30-day expiration for staging SOA PDFs
- Deployable via SAM CLI or GitHub Actions

**Disclaimer:** This repository is for educational and portfolio demonstration purposes only. It demonstrates serverless architecture, event-driven pipelines, and PDF manipulation on AWS. The author is not affiliated with Converge ICT. Use at your own risk in compliance with the service provider's Terms of Service.

## Repository Layout

```
.
├── template.yaml            # SAM / CloudFormation infrastructure
├── samconfig.toml           # Local deploy defaults (gitignored, personal values)
├── samconfig.toml.example   # Committable template; copy to samconfig.toml
├── src/                     # Lambda function source (ESM, Node 22)
│   ├── index.mjs            # Handler entry point (index.handler)
│   └── package.json         # Lambda runtime dependencies
└── events/event.json        # Sample payload for local invocation
```

## Environment Variables

The Lambda reads these from its runtime environment (`process.env`). Values are supplied at deploy time via CloudFormation `--parameter-overrides`.

| Environment Variables  | Description                                  | Required |
| ---------------------- | -------------------------------------------- | -------- |
| `USER_EMAIL`           | Email address the unlocked SOA is sent to    | ✓        |
| `USER_MOBILE`          | Registered mobile number used for OTP        | ✓        |
| `CONVERGE_API_URL`     | Base URL of the Converge SOA API             | ✓        |
| `SOA_BUCKET_NAME`      | S3 bucket where downloaded SOA PDFs go       | ✓        |
| `PDF_PASSWORD`         | Password that unlocks the SOA PDF            | ✓        |
| `CONVERGE_ACCOUNT_NO`  | Converge account number for the SOA flow     | ✓        |
| `GMAIL_CLIENT_ID`      | Google OAuth2 client ID for the Gmail API    | ✓        |
| `GMAIL_CLIENT_SECRET`  | Google OAuth2 client secret                  | ✓        |
| `GMAIL_REFRESH_TOKEN`  | Offline refresh token for Gmail API access   | ✓        |

## Deploy Parameters

CloudFormation parameters you pass on deploy (mapped to the function env in `template.yaml`):

| Parameter         | Default                          | Notes                          |
| ----------------- | -------------------------------- | ------------------------------ |
| `Environment`     | `dev`                            | `dev` / `prod` (used for tags) |
| `Runtime`         | `nodejs22.x`                     |                                |
| `Handler`         | `index.handler`                  |                                |
| `CodeUri`         | `./src`                          |                                |
| `UserEmail`       | —                                | NoEcho (secret), required      |
| `UserMobile`      | —                                | NoEcho (secret), required      |
| `PdfPassword`     | —                                | NoEcho (secret), required      |
| `ConvergeAccountNo` | —                              | Required                       |
| `ConvergeApiUrl`  | `https://get-soa.convergeict.com/api/v1/account` |                          |
| `SoaBucketName`   | —                                | Must be globally unique        |
| `GmailClientId`   | —                                | Google OAuth2 client ID        |
| `GmailClientSecret` | —                            | NoEcho (secret), required      |
| `GmailRefreshToken` | —                           | NoEcho (secret), required      |

## Prerequisites

- AWS CLI (`aws configure`)
- AWS SAM CLI
- Node.js 22 (for local testing)

## Google OAuth 2.0 & Refresh Token Setup

Guide for setting up Google OAuth 2.0 credentials and generating a long-lived `REFRESH_TOKEN` for programmatic Gmail access. The Lambda uses it to read the Converge OTP from your inbox.

---

### 1. Google Cloud Console Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one) and enable the **Gmail API**.
3. Configure the **OAuth consent screen**:
   - Set User Type to **External**.
   - Add your Gmail address under **Audience / Test users**.
4. Go to **Credentials > + Create Credentials > OAuth client ID**:
   - Select **Web application** as the application type.
   - Add the following to **Authorised redirect URIs**:
     ```text
     https://oauth.pstmn.io/v1/browser-callback
     https://developers.google.com/oauthplayground
     ```
5. Click **Create** and save your `Client ID` and `Client Secret`.

### 2. Generating the Refresh Token

1. Open [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/).
2. Click the **Gear Icon (⚙️)** in the top-right corner.
3. Check **Use your own OAuth credentials** and enter your `Client ID` and `Client Secret`.
4. Under **Step 1 (Select & authorize APIs)**, enter the required scope in the text box:
   ```text
   https://www.googleapis.com/auth/gmail.readonly
   ```
5. Click **Authorize APIs**, select your test Gmail account, and grant permissions.
6. In **Step 2 (Exchange authorization code for tokens)**, click **Exchange authorization code for tokens**.
7. Copy the generated `refresh_token` from the response body.

### 3. Environment Configuration

Store these credentials securely in your environment (`.env` or AWS Lambda environment variables):

```env
GMAIL_CLIENT_ID="your-client-id"
GMAIL_CLIENT_SECRET="your-client-secret"
GMAIL_REFRESH_TOKEN="1//04..."
```

Wire them into deployment as the `GmailClientId`, `GmailClientSecret`, and `GmailRefreshToken` parameters (see Environment Variables / Deploy Parameters above).

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

## Local testing

```bash
# Build and invoke the function with a sample event
sam local invoke SoaAutomationFunction -e events/event.json \
  --parameter-overrides \
    "UserEmail=test@example.com UserMobile=09000000000 \
     ConvergeApiUrl=https://get-soa.convergeict.com/api/v1/account \
     SoaBucketName=isp-soa-automation-dev-local"
```

## Cleanup

```bash
sam delete --stack-name isp-soa-automation
```