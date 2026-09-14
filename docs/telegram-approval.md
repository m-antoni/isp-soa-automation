# Telegram Approve-to-Merge Workflow

This feature lets you **approve pull requests (PRs) to your `master` branch from
your phone using Telegram** — for free. When someone opens a PR targeting
`master`, a Telegram bot sends you a message. Reply `yes` and the code runs
checks and merges the PR automatically. Reply `no` and it rejects it.

The workflow file is `.github/workflows/approve-merge-to-master.yml`.

---

## How it works (plain English)

| Step | Job name in workflow | What happens |
| ---- | -------------------- | ------------ |
| 1 | `notify` | Someone opens a PR to `master`. The workflow asks Telegram: "send a message to my chat". You get a DM from your bot like: *"New PR #12 'Update login' wants to merge into master. Reply YES to run checks and merge, or NO to reject."* |
| 2 | `wait-for-approval` | The workflow keeps checking Telegram every ~20 seconds, looking for a **new** message from **your** chat ID. If you reply `yes`/`y`/`approve` → it continues. If `no`/`n`/`reject` → it cancels the whole run. If you don't reply within 30 minutes, it cancels ("timeout"). |
| 3 | `merge` | Runs the checks (`npm ci` + `npm test` inside `src/`), then merges your PR using `gh pr merge --squash --delete-branch` — i.e. squash-merge into master and delete the branch. |

**Important detail:** the workflow talks to Telegram using Telegram's
`getUpdates` endpoint (long-polling), so there is **no server or hosting to pay
for**. That is also why this is not available for Viber — Viber's API requires a
webhook server, which costs money/infra.

---

## What you need before you start (3 secrets)

The workflow needs three pieces of information, stored as GitHub **secrets**
(encrypted values the workflow can read but you can't see again later):

| Secret                 | What it is                                          | Example value                  |
| ---------------------- | --------------------------------------------------- | ------------------------------ |
| `TELEGRAM_BOT_TOKEN`   | Password for your Telegram bot, from @BotFather     | `123456789:AAHf4xY...`         |
| `TELEGRAM_CHAT_ID`     | Your private chat number with the bot               | `123456789`                    |
| `GH_BOT_TOKEN`         | A GitHub "password" that lets the workflow merge    | `github_pat_11AA...`           |

> **Do NOT put these in `template.yaml`, `samconfig.toml`, or `.env`.** They are
> GitHub Actions secrets only. The Lambda function never uses Telegram.

---

## Step by step setup

### Part A — Create the Telegram bot and get your Chat ID (5 min)

**A.1 Create the bot (from the Telegram app or https://web.telegram.org):**

1. Open Telegram and tap the **search bar** at the top.
2. Type `BotFather` and open the chat with the official bot **@BotFather**
   (shows a blue check mark).
3. In chat, send this command:
   ```
   /newbot
   ```
4. BotFather asks for a **name** (this is just a display name, can be anything):
   ```
   Master Merge Bot
   ```
5. Then it asks for a **username**. It MUST end in `bot`. Type:
   ```
   masterMergeBot
   ```
6. BotFather replies with something like:
   ```
   Done! Follow @masterMergeBot ...
   Use this token to access the HTTP API:
   123456789:AAHf4xY...yourTokenHere
   ```
   **Copy the long `123456789:AA...` string after "HTTP API:"** — that is your
   `TELEGRAM_BOT_TOKEN`.

> Lost the token? In @BotFather send `/mybots` → tap your bot → **API Token** → `/token`.

**A.2 Get your Chat ID:**

1. Open a chat with **your new bot** (search `masterMergeBot`) and send any
   message, e.g.:
   ```
   hi
   ```
2. Open this web address in your browser (replace `<YOUR_TOKEN>` with the real
   token from step A.1 — remove the `<` `>` brackets):
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
3. You will see a `json` page. Look for text like:
   ```json
   "chat": { "id": 123456789, "first_name": "You" }
   ```
   The number after `"id":` (**e.g. `123456789`**) is your `TELEGRAM_CHAT_ID`.

---

### Part B — Create the GitHub token (5 min)

This is a special GitHub password that lets the workflow press the "merge"
button for you (the normal workflow token is not allowed to merge to `master`).

1. Click your **profile picture** (top-right on github.com) → **Settings**.
2. Left sidebar, scroll down → **Developer settings**.
3. Left sidebar → **Personal access tokens** → **Fine-grained tokens**.
4. Click **Generate new token**. (Skip this if you want a pre-filled one: open
   https://github.com/settings/personal-access-tokens/new?name=master-merge-bot&contents=write&pull_requests=write
   and go straight to step 7.)
5. Fill the form:
   - **Token name:** `master-merge-bot` (anything)
   - **Expiration:** leave default (30 days)
   - **Repository access:** choose **Only select repositories** → tick your repo
     (or **All repositories** if you want to reuse this one token on other repos)
6. Scroll to **Permissions** and find the **Repository permissions** list. Do
   this twice, once for each name:
   - Type `Pull requests` in the search → select it → choose **Read and write**
   - Type `Contents` in the search → select it → in the new menu next to it
     choose **Read and write**
   - Leave **Metadata** at **Read-only** (GitHub requires it — don't touch it)

   > **Both permissions are required.** Without `Pull requests: Read and write`
   > the merge is denied; without `Contents: Read and write` the merge fails with
   > `GraphQL: Resource not accessible by personal access token` (the squash merge
   > and branch delete also need repo write access). If you already created the
   > token, click **Edit** on it and add whichever is missing — the token value
   > stays the same, so you only need to re-copy it into the secret if you
   > regenerated it.
7. Click **Generate token** at the bottom.
8. **Copy the new token immediately** (starts with `github_pat_...`). GitHub
   shows it only once. This is your `GH_BOT_TOKEN`.

---

### Part C — Save the 3 secrets in GitHub (2 min)

1. Open: `https://github.com/YOUR_USERNAME/isp-soa-automation/settings/secrets/actions`
   (replace `YOUR_USERNAME` with your GitHub username).
2. Click **New repository secret** and add **one secret at a time** (3 times):

   | Name | Value |
   | ---- | ----- |
   | `TELEGRAM_BOT_TOKEN` | the `123456789:AA...` token from Part A |
   | `TELEGRAM_CHAT_ID` | the number `id` from Part A (e.g. `123456789`) |
   | `GH_BOT_TOKEN` | the `github_pat_...` token from Part B |

3. Each time: click **Add secret**.

---

### Part D — Deploy the workflow (1 min)

1. Make sure `.github/workflows/approve-merge-to-master.yml` exists in your repo
   (it was created for you).
2. Commit and push it to `master`.

---

## Testing it

1. Create a feature branch, make any change, push it, then open a **Pull request
   to `master`**.
2. Check Telegram — your bot should DM you the PR details.
3. Reply `yes` (or `y`, `approve`):
   - Workflow goes to the `merge` job → runs `npm ci` and `npm test` → squashes
     the PR into master → deletes the branch.
4. Reply `no` instead, to test rejection:
   - The workflow stops and the run shows as failed (that is expected for a
     rejection).

---

## Troubleshooting

| Problem | Likely cause & fix |
| ------- | ------------------ |
| No Telegram message | Secrets missing or wrong — re-check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in Part C. |
| `chat_id` not found in the JSON | You didn't message your bot first — send `hi` to the bot, then reload the `/getUpdates` URL. |
| Merge fails with "permission" | `GH_BOT_TOKEN` missing, wrong, or expired (fine-grained tokens expire). Re-create per Part B. |
| Merge denied on protected `master` | Your account must have branch-protection bypass rights. Add yourself as an admin/with bypass. |
| Workflow times out after 30 min | You didn't reply in time, or you replied from a different Telegram account/chat. |
| Replies to an older PR | The workflow only accepts messages **newer** than its own notification and from **your** chat ID. |

---

## FAQ

**Is it free?** Yes. Telegram Bot API has no cost. GitHub Actions has a free
minute allowance (2,000 min/month on private repos, unlimited on public repos).
The only cost is the ~30-minute wait job counts toward those minutes if a PR is
left unapproved that long.

**One bot for many repos?** Yes — the same `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` work in every repo. Add the same workflow file + `GH_BOT_TOKEN`
to each repo.

**Why not Viber?** Viber's API has no "poll for new replies" endpoint like
Telegram's `getUpdates`, so it would need a paid/public webhook server to receive
your reply.

**Why do I need `GH_BOT_TOKEN`?** GitHub's built-in workflow token cannot merge
PRs. The Personal Access Token acts as "you" to perform the merge.