# Google OAuth 2.0 & Refresh Token Setup

Guide for setting up Google OAuth 2.0 credentials and generating a long-lived
`REFRESH_TOKEN` for programmatic Gmail access. The Lambda uses it to read the
Converge OTP from your inbox.

---

## 1. Google Cloud Console Credentials

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

> **Tip:** The **Gmail API must be enabled on the project the OAuth client belongs to**, otherwise calls fail with `403` / `SERVICE_DISABLED`. You can verify (and enable) it here, substituting your project ID:
> [`https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=<PROJECT_ID>`](https://console.developers.google.com/apis/api/gmail.googleapis.com/overview)
> After enabling, wait a few minutes for the change to propagate before re-running the Lambda.

## 2. Generating the Refresh Token

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

## 3. Environment Configuration

Store these credentials securely in your environment (`.env` or AWS Lambda environment variables):

```env
GMAIL_CLIENT_ID="your-client-id"
GMAIL_CLIENT_SECRET="your-client-secret"
GMAIL_REFRESH_TOKEN="1//04..."
```

Wire them into deployment as the `GmailClientId`, `GmailClientSecret`, and
`GmailRefreshToken` parameters (see Environment Variables / Deploy Parameters in
the root README).