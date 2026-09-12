import { PDFDocument } from "pdf-lib";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { fetchOtpFromGmail } from "./gmail.mjs";

const s3 = new S3Client({});
const ses = new SESClient({});

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
  MAIL_FROM,
  MAIL_TO,
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
  MAIL_FROM,
  MAIL_TO,
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

  // ** Step 2: POST {CONVERGE_API_URL}/soa/ with { acct_no } to trigger the OTP email
  const sendOTP = await sendOtpViaEmail({
    acct_no: config.CONVERGE_ACCOUNT_NO,
  });
  console.log("SEND OTP", JSON.stringify(sendOTP));

  // ** Step 3: POST {CONVERGE_API_URL}/soa/validate/ with { acct_no, token: <otp> } -> session token + items
  if (sendOTP.success && sendOTP.data) {
    // OTP received from GMAIL
    const otp = await fetchOtpFromGmail();
    console.log("OTP FROM GMAIL", otp);

    const verifyOTP = await validateOTP({
      acct_no: config.CONVERGE_ACCOUNT_NO,
      token: otp,
    });
    console.log("Verify OTP", JSON.stringify(verifyOTP));

    // ** Step 4: GET {CONVERGE_API_URL}/soa/{acct_no}/{token}/{items[0].slug}/ to download the latest PDF
    if (verifyOTP && verifyOTP.success) {
      const soaBuffer = await downloadPdf(verifyOTP);
      console.log("SOA PDF BYTES", soaBuffer.length);

      // Step 5: Unlock the encrypted PDF loaded with the account password.
      const pdfDoc = await PDFDocument.load(new Uint8Array(soaBuffer), {
        password: config.PDF_PASSWORD,
      });
      const unlockedBytes = await pdfDoc.save();
      console.log("UNLOCKED PDF BYTES", unlockedBytes.length);

      // Step 6: Upload the unlocked PDF to the SOA bucket.
      const { month, fileName } = soaFileNames();
      const s3Key = `soa/${config.CONVERGE_ACCOUNT_NO}/${month}/${fileName}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: config.SOA_BUCKET_NAME,
          Key: s3Key,
          Body: new Uint8Array(unlockedBytes),
          ContentType: "application/pdf",
        })
      );
      console.log("UPLOADED S3", s3Key);

      // Step 7: Email the unlocked SOA PDF via SES.
      await sendPdfEmail({ fileName, buffer: Buffer.from(unlockedBytes) });
      return {
        statusCode: 200,
        body: JSON.stringify({ status: "SUCCESS", s3Key }),
      };
    }
  }

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

    return await response.json();
  } catch (error) {
    console.error("Something went wrong!: ", error);
  }
}

// ** Download the latest SOA PDF
// Relies on the session token + item slug from the validateOTP response.
// The response shape is not guaranteed, so it tolerates a few common layouts
// and throws with the full response if the values cannot be located.
async function downloadPdf(verifyOTP) {
  const data = verifyOTP.data ?? verifyOTP;
  const sessionToken = data.token ?? data.session_token ?? data.sessionToken;
  const item = data.items?.[0] ?? data.data?.items?.[0];
  const slug = item?.slug;

  if (!sessionToken || !slug) {
    throw new Error(
      `Cannot locate session token/slug in validateOTP response: ${JSON.stringify(
        verifyOTP
      )}`
    );
  }

  const response = await fetch(
    `${config.CONVERGE_API_URL}/soa/${config.CONVERGE_ACCOUNT_NO}/${sessionToken}/${slug}/`,
    {
      headers: { Accept: "application/pdf" },
    }
  );

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  return await response.arrayBuffer();
}

// ** Helper: current period + file name used for the S3 object
// File name always uses the 15th as the day (e.g. SOA-2026-01-15.pdf).
function soaFileNames() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return {
    month: `${yyyy}-${mm}`,
    fileName: `SOA-${yyyy}-${mm}-15.pdf`,
  };
}

// ** Build a MIME multipart/mixed message with the SOA PDF as an attachment.
function buildMimeMessage({ to, from, subject, body, fileName, pdfBuffer }) {
  const boundary = `----isp-soa-${Date.now()}`;
  const content = [
    "MIME-Version: 1.0",
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    body,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${fileName}"`,
    `Content-Disposition: attachment; filename="${fileName}"`,
    "Content-Transfer-Encoding: base64",
    "",
    pdfBuffer.toString("base64"),
    `--${boundary}--`,
  ].join("\r\n");

  return Buffer.from(content, "utf8");
}

// ** Send the unlocked SOA PDF via SES (SendRawEmail supports attachments).
async function sendPdfEmail({ fileName, buffer }) {
  const raw = buildMimeMessage({
    to: config.MAIL_TO,
    from: config.MAIL_FROM,
    subject: `Your Converge SOA (${fileName})`,
    body: "The latest Converge Statement of Account is attached.",
    fileName,
    pdfBuffer: buffer,
  });

  await ses.send(new SendRawEmailCommand({ Raw: { Data: raw } }));
  console.log("EMAIL SENT VIA SES", fileName);
}
