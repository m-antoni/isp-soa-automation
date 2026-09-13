import { PDFDocument } from "pdf-lib";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import nodemailer from "nodemailer";
import createQpdfModule from "@neslinesli93/qpdf-wasm";
import { fetchOtpFromGmail } from "./gmail.mjs";

const s3 = new S3Client({});

// pdf-lib cannot decrypt password-protected PDFs, so we use qpdf (WASM).
// The module is loaded once per container; FS is in-memory (MEMFS).
const qpdfStderr = [];
let qpdfModulePromise;
function getQpdf() {
  if (!qpdfModulePromise) {
    qpdfModulePromise = createQpdfModule({
      noInitialRun: true,
      noExitRuntime: true,
      printErr: (message) => qpdfStderr.push(String(message)),
    });
  }
  return qpdfModulePromise;
}

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
  GMAIL_SMTP_APP_PASSWORD,
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
  GMAIL_SMTP_APP_PASSWORD,
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

      // Step 5: Unlock the encrypted PDF with the account password via qpdf.
      const unlockedBytes = await decryptSoaPdf(soaBuffer, config.PDF_PASSWORD);
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

      // Step 7: Email the unlocked SOA PDF via Gmail SMTP.
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

// ** Decrypt a password-protected PDF via the qpdf WASM build.
// Returns a Buffer of the unprotected PDF (content-preserving, streams intact).
async function decryptSoaPdf(soaBuffer, password) {
  const qpdf = await getQpdf();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inPath = `/in-${tag}.pdf`;
  const outPath = `/out-${tag}.pdf`;
  qpdfStderr.length = 0;

  try {
    qpdf.FS.writeFile(inPath, new Uint8Array(soaBuffer));
    qpdf.callMain([inPath, "--decrypt", `--password=${password}`, outPath]);
  } catch (error) {
    throw new Error(
      `qpdf decrypt failed (check PDF_PASSWORD): ${qpdfStderr.join(" ") || error.message}`
    );
  } finally {
    try {
      qpdf.FS.unlink(inPath);
    } catch {
      /* ignore */
    }
  }

  let decrypted;
  try {
    decrypted = Buffer.from(qpdf.FS.readFile(outPath));
  } catch {
    throw new Error(
      `qpdf produced no output (wrong PDF_PASSWORD?): ${qpdfStderr.join(" ")}`
    );
  } finally {
    try {
      qpdf.FS.unlink(outPath);
    } catch {
      /* ignore */
    }
  }

  try {
    // pdf-lib can now open it (no longer encrypted), which also validates it.
    await PDFDocument.load(decrypted);
  } catch (error) {
    console.error(
      "FAILED TO UNLOCK PDF",
      JSON.stringify(inspectPdfEncryption(soaBuffer))
    );
    throw new Error(
      `qpdf produced an unusable PDF: ${error.message}. qpdf: ${qpdfStderr.join(" ")}`
    );
  }
  return decrypted;
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

// ** Pull minimal encryption metadata out of a PDF so unlock failures can be
// diagnosed: wrong PDF_PASSWORD vs an encryption pdf-lib cannot handle
// (e.g. AES-256 /V 5, /R 5 or 6).
function inspectPdfEncryption(bytes) {
  const body = Buffer.from(bytes).toString("latin1");
  const encryptMatch = body.match(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/);
  const details = {
    header: Buffer.from(bytes)
      .subarray(0, 16)
      .toString("latin1")
      .replace(/[^\x20-\x7e]/g, "."),
    hasEncryptDict: Boolean(encryptMatch),
  };

  if (encryptMatch) {
    details.encryptObj = Number(encryptMatch[1]);
    const filter = body.match(/\/Filter\s+\/(\w+)/);
    if (filter) details.filter = filter[1];
    const v = body.match(/\/V\s+(\d+)/);
    if (v) details.version = Number(v[1]);
    const r = body.match(/\/R\s+(\d+)/);
    if (r) details.revision = Number(r[1]);
    if (body.includes("/AESV3")) details.cf = "AESV3";
    else if (body.includes("/AESV2")) details.cf = "AESV2";
  }
  return details;
}

// ** Send the unlocked SOA PDF via Gmail SMTP (Google's own servers, so the
// mail isn't flagged as spam). Uses an App Password, not the account password.
async function sendPdfEmail({ fileName, buffer }) {
  const mailer = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: config.MAIL_FROM,
      pass: config.GMAIL_SMTP_APP_PASSWORD,
    },
  });

  try {
    const info = await mailer.sendMail({
      from: config.MAIL_FROM,
      to: config.MAIL_TO,
      subject: `Your Converge SOA (${fileName})`,
      text: "The latest Converge Statement of Account is attached.",
      attachments: [{ filename: fileName, content: buffer }],
    });
    console.log("EMAIL SENT VIA GMAIL SMTP", fileName, info.messageId ?? "");
  } finally {
    mailer.close();
  }
}
