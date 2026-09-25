# Google OAuth 2.0 & Refresh Token Setup

Guide for setting up Google OAuth 2.0 credentials and generating a long-lived, non-expiring `REFRESH_TOKEN` for programmatic Gmail access. The Lambda uses it to read the Converge OTP from your inbox.

---

## 1. Google Cloud Console Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one) and enable the **Gmail API**.
3. Go to **Credentials > + Create Credentials > OAuth client ID**:
   - Select **Web application** as the application type.
   - Add the following to **Authorised redirect URIs**:
     ```text
     https://oauth.pstmn.io/v1/browser-callback
     https://developers.google.com/oauthplayground
     ```
4. Click **Create** and save your `Client ID` and `Client Secret`.

> **Tip:** The **Gmail API must be enabled on the project the OAuth client belongs to**, otherwise calls fail with `403` / `SERVICE_DISABLED`. You can verify (and enable) it here, substituting your project ID:
> [`https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=<PROJECT_ID>`](https://console.developers.google.com/apis/api/gmail.googleapis.com/overview)
> After enabling, wait a few minutes for the change to propagate before re-running the Lambda.

---

## 2. Configure & Publish OAuth Consent Screen

By default, Google sets new OAuth projects to **Testing** mode, which causes issued refresh tokens to expire after 7 days (`"refresh_token_expires_in": 604799`). To prevent expiration, publish the consent screen:

1. In Google Cloud Console, navigate to **APIs & Services > Google Auth Platform** (or **OAuth consent screen**).
2. Under **Audience / Publishing status**, click **Publish App** to switch from _Testing_ to **In production**.
3. Fill in the required fields using your repository links:
   - **App name**: Your project name.
   - **User support email**: Your email address.
   - **Application home page**: `https://github.com/<your-username>/<your-repo-name>`
   - **Application privacy policy link**: `https://github.com/<your-username>/<your-repo-name>`
   - **Authorised domains**: `github.com`
   - **Developer contact information**: Your email address.
4. Click **Save and Continue**.
5. **Note on Verification:** If Google prompts you to submit the app for verification due to restricted scopes (`gmail.readonly`), **skip or cancel the verification request**. Verification is only needed for public multi-user apps. For personal automation, setting status to **In production** is sufficient.

---

## 3. Generating a Permanent Refresh Token

1. Open [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/).
2. Click the **Gear Icon (⚙️)** in the top-right corner.
3. Ensure **OAuth endpoints** is set to **Google**.
4. Check **Use your own OAuth credentials** and enter your `Client ID` and `Client Secret`.
5. Click **Close**.
6. Under **Step 1 (Select & authorize APIs)**, scroll down to **Input your own scopes** at the bottom and enter:
   ```text
   https://www.googleapis.com/auth/gmail.readonly
   ```
7. Click **Authorize APIs**, select your Gmail account, and grant permissions.
   - _If shown an "Unverified App" warning, click **Advanced > Go to [App Name] (unsafe)** to proceed._
8. In **Step 2 (Exchange authorization code for tokens)**, click **Exchange authorization code for tokens**.
9. Copy the generated `refresh_token` from the response body.

### How to Verify Non-Expiration

Inspect the JSON response under **Step 2**:

- **Permanent Token (Success):** The field `"refresh_token_expires_in"` is **completely absent**. Only `"expires_in": 3599` (the 1-hour access token) is listed.
- **7-Day Token (Failure):** Contains `"refresh_token_expires_in": 604799`. Ensure **Use your own OAuth credentials** was checked in Step 3 and the app status is **In production**.

---

## 4. Environment Configuration

Store these credentials securely in your environment (`.env` or AWS Lambda environment variables):

```env
GMAIL_CLIENT_ID="your-client-id"
GMAIL_CLIENT_SECRET="your-client-secret"
GMAIL_REFRESH_TOKEN="1//04..."
```

Wire them into deployment as the `GmailClientId`, `GmailClientSecret`, and `GmailRefreshToken` parameters (see Environment Variables / Deploy Parameters in the root README).
