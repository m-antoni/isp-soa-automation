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
} = process.env;

const config = {
  USER_EMAIL,
  USER_MOBILE,
  CONVERGE_API_URL,
  SOA_BUCKET_NAME,
  PDF_PASSWORD,
  CONVERGE_ACCOUNT_NO,
};

for (const [key, value] of Object.entries(config)) {
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
}

export const handler = async (event, context) => {
  // TODO: implement the pipeline. Steps to follow (see notes.md):
  // Step 1: POST {CONVERGE_API_URL}/ with { acct_no, is_tac, is_privacy_notice, is_converge }
  const getAccount = await getAccountDetails({
    acct_no: CONVERGE_ACCOUNT_NO,
    is_tac: true,
    is_privacy_notice: true,
    is_converge: true,
  });

  // Step 2: POST {CONVERGE_API_URL}/soa/ with { acct_no } to trigger the OTP email
  // Step 3: POST {CONVERGE_API_URL}/soa/validate/ with { acct_no, token: <otp> } -> session token + items
  // Step 4: GET {CONVERGE_API_URL}/soa/{acct_no}/{token}/{items[0].slug}/ to download the latest PDF
  // Step 5: Unlock the encrypted PDF with PDFDocument.load(bytes, { password: PDF_PASSWORD })
  // Step 6: Upload the unlocked PDF to the SOA bucket via PutObjectCommand
  // Step 7: Return the result as JSON in the response body

  return {
    statusCode: 200,
    body: JSON.stringify(getAccount),
  };
};

// ** Enter Account Details
async function getAccountDetails(payload = {}) {
  try {
    const response = await fetch(`${config.CONVERGE_API_URL}`, {
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
