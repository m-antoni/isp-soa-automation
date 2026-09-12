import { PDFDocument } from "pdf-lib";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// Config loaded from the Lambda environment.
const {
  USER_EMAIL,
  USER_MOBILE,
  CONVERGE_API_URL,
  SOA_BUCKET_NAME,
  PDF_PASSWORD,
  CONVERGE_ACCOUNT_NO,
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
} = process.env;

const config = {
  USER_EMAIL,
  USER_MOBILE,
  CONVERGE_API_URL,
  SOA_BUCKET_NAME,
  PDF_PASSWORD,
  CONVERGE_ACCOUNT_NO,
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
};

for (const [key, value] of Object.entries(config)) {
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
}

export const handler = async (event, context) => {
  // TODO: implement the pipeline. Steps to follow (see notes.md):
  // Step 1: POST {CONVERGE_API_URL}/ with { acct_no, is_tac, is_privacy_notice, is_converge }
  // const getAccount = await getAccountDetails({
  //   acct_no: CONVERGE_ACCOUNT_NO,
  //   is_tac: true,
  //   is_privacy_notice: true,
  //   is_converge: true,
  // });

  // console.log("GET_ACCOUNT", JSON.stringify(getAccount));

  // Step 2: POST {CONVERGE_API_URL}/soa/ with { acct_no } to trigger the OTP email
  const sendOTP = await sendOtpViaEmail({
    acct_no: config.CONVERGE_ACCOUNT_NO,
  });
  console.log("SEND OTP", JSON.stringify(sendOTP));

  // Step 3: POST {CONVERGE_API_URL}/soa/validate/ with { acct_no, token: <otp> } -> session token + items
  if (sendOTP.success && sendOTP.data) {
    const otp = await fetchOtpFromGmail();
    console.log("OTP FROM GMAIL", otp);

    const verifyOTP = await validateOTP({
      acct_no: config.CONVERGE_ACCOUNT_NO,
      token: await fetchOtpFromGmail(),
    });
    console.log("Verify OTP", JSON.stringify(verifyOTP));
  }

  // Step 4: GET {CONVERGE_API_URL}/soa/{acct_no}/{token}/{items[0].slug}/ to download the latest PDF
  // Step 5: Unlock the encrypted PDF with PDFDocument.load(bytes, { password: PDF_PASSWORD })
  // Step 6: Upload the unlocked PDF to the SOA bucket via PutObjectCommand
  // Step 7: Return the result as JSON in the response body

  return {
    statusCode: 200,
    body: "SUCCESS",
  };
};

// ** Enter Account Details
async function getAccountDetails(payload = {}) {
  try {
    const response = await fetch(`${config.CONVERGE_API_URL}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    // Handle empty responses (like 204 No Content)
    if (response.status === 204) return null;

    return await response.json();
  } catch (error) {
    console.error("Something went wrong!: ", error);
  }
}

// ** Sent OTP to email
async function sendOtpViaEmail(payload = {}) {
  try {
    const response = await fetch(`${config.CONVERGE_API_URL}/soa/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    // Handle empty responses (like 204 No Content)
    if (response.status === 204) return null;

    return await response.json();
  } catch (error) {
    console.error("Something went wrong!: ", error);
  }
}

// ** Validate the OTP
async function validateOTP(payload = {}) {
  try {
    const response = await fetch(`${config.CONVERGE_API_URL}/soa/validate/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    // Handle empty responses (like 204 No Content)
    if (response.status === 204) return null;

    return await response.json();
  } catch (error) {
    console.error("Something went wrong!: ", error);
  }
}

// ** Get a fresh Gmail API access token from the refresh token
async function getGmailAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.GMAIL_CLIENT_ID,
      client_secret: config.GMAIL_CLIENT_SECRET,
      refresh_token: config.GMAIL_REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Token refresh failed: ${response.status} ${await response.text()}`
    );
  }

  return (await response.json()).access_token;
}

// ** Fetch the latest Converge OTP from Gmail
// Looks up the most recent Converge OTP email and returns its 6-character code.
// Strategy:
//   1. Query Gmail for messages from Converge (with a subject-based fallback).
//   2. Decode the newest message body (recursively).
//   3. Extract the code from the Subject header (most reliable) and/or the body.
//   The email can take a few seconds to arrive, so it retries a few times.
async function fetchOtpFromGmail() {
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

      // Gmail returns the newest message first, so messages[0] is the latest OTP.
      const msg = await (
        await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messages[0].id}?format=full`,
          { headers }
        )
      ).json();

      // The Subject always carries the code
      // (e.g. "Your Converge Confirmation Code: 3DOJS4").
      const subject =
        msg.payload?.headers?.find((h) => h.name === "Subject")?.value ?? "";
      console.log("GMAIL MSG SUBJECT", subject);

      const body = decodeMessageBody(msg.payload);
      const code =
        /Confirmation Code:?\s*([A-Z0-9]{6})/i.exec(subject)?.[1] ??
        /Your Confirmation Code:\s*([A-Z0-9]{6})/.exec(body)?.[1] ??
        body.match(/\b[A-Z0-9]{6}\b/)?.[0];

      if (code) {
        console.log("OTP", code);
        return code;
      }
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
