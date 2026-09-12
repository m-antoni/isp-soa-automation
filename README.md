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
├── template.yaml        # SAM / CloudFormation infrastructure
├── samconfig.toml       # Local deploy defaults (gitignored)
├── src/                 # Lambda function source (ESM, Node 22)
│   ├── index.mjs        # Handler entry point (index.handler)
│   └── package.json     # Lambda runtime dependencies
└── events/event.json    # Sample payload for local invocation
```

## Environment Variables

The Lambda reads these from its runtime environment (`process.env`). Values are supplied at deploy time via CloudFormation `--parameter-overrides`.

| Variable          | Description                                  | Required |
| ----------------- | -------------------------------------------- | -------- |
| `USER_EMAIL`      | Email address the unlocked SOA is sent to    | ✓        |
| `USER_MOBILE`     | Registered mobile number used for OTP        | ✓        |
| `CONVERGE_API_URL`| Base URL of the Converge SOA API             | ✓        |

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
| `ConvergeApiUrl`  | `https://get-soa.convergeict.com/api/v1/account` |                          |
| `SoaBucketName`   | —                                | Must be globally unique        |

## Prerequisites

- AWS CLI (`aws configure`)
- AWS SAM CLI
- Node.js 22 (for local testing)

## Deployment

### Manual deploy

```bash
# 1. Build the Lambda package (installs dependencies in src/)
sam build

# 2. Deploy (creates or updates the stack)
sam deploy --guided
```

`--guided` walks you through parameters and saves them to `samconfig.toml` (gitignored). For repeatable/CI deploys, pass overrides directly:

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