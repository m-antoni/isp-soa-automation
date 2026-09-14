// Gmail API helpers (OAuth2) used to read the Converge OTP from the inbox.
// Reads its config from the Lambda environment (same vars as index.mjs).

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } =
  process.env;

// ** Get a fresh Gmail API access token from the refresh token
async function getGmailAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Token refresh failed: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()).access_token;
}

// ** Fetch the most recent Converge OTP candidates from Gmail
// Gmail lists the newest message first, but multiple OTP emails can coexist in
// the inbox (e.g. a previous run's code still sitting there), so this returns a
// deduped array of codes from the newest few messages - newest message first.
// Strategy:
//   1. Query Gmail for messages from Converge (with a subject-based fallback).
//   2. Decode the newest few message bodies (recursively).
//   3. Extract the code from the Subject header (most reliable) and/or the body.
//   The email can take a few seconds to arrive, so it retries a few times.
export async function fetchOtpFromGmail() {
  const accessToken = await getGmailAccessToken();
  const headers = { Authorization: `Bearer ${accessToken}` };

  // Queries tried in order; the subject fallback covers cases where the
  // from: index or sender formatting differs across Gmail clients.
  const queries = [
    "from:noreply@soa.convergeict.com newer_than:2h",
    'subject:"Confirmation Code" newer_than:2h',
  ];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    for (const query of queries) {
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
          query
        )}`,
        { headers }
      );
      if (!listRes.ok) {
        console.error(
          `Gmail search failed (status ${listRes.status}): ${await listRes.text()}`
        );
        continue;
      }

      const { messages = [] } = await listRes.json();
      if (messages.length === 0) continue;

      const codes = [];
      for (const { id } of messages.slice(0, 5)) {
        const msg = await (
          await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
            { headers }
          )
        ).json();

        // The Subject always carries the code
        // (e.g. "Your Converge Confirmation Code: 3DOJS4").
        const subject =
          msg.payload?.headers?.find((h) => h.name === "Subject")?.value ?? "";
        console.log("GMAIL MSG SUBJECT", subject);

        const body = decodeMessageBody(msg.payload);
        const candidates = [
          /Confirmation Code:?\s*([A-Z0-9]{6})/i.exec(subject)?.[1],
          /Your Confirmation Code:\s*([A-Z0-9]{6})/.exec(body)?.[1],
          body.match(/\b[A-Z0-9]{6}\b/)?.[0],
        ];
        for (const candidate of candidates) {
          if (candidate) codes.push(candidate);
        }
      }

      if (codes.length > 0) return [...new Set(codes)];
    }

    // OTP emails usually land within a few seconds - wait before retrying.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  throw new Error("OTP not found in Gmail after multiple attempts");
}

// ** Decode (base64url) the text of a Gmail message payload
// Gmail messages can be nested multipart structures, so walk every part and
// collect all text/* bodies (plain-text and HTML), then join them for scanning.
function decodeMessageBody(payload) {
  const chunks = [];

  const walk = (node) => {
    if (!node) return;
    if ((node.mimeType ?? "").startsWith("text/") && node.body?.data) {
      chunks.push(node.body.data);
    }
    (node.parts ?? []).forEach(walk);
  };

  walk(payload);

  return chunks
    .map((data) =>
      Buffer.from(
        data.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString("utf8")
    )
    .join("\n");
}