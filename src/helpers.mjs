// Pure helper functions shared by index.mjs and gmail.mjs.
// This module has NO side effects and no environment/network dependencies,
// so it can be unit-tested directly.

// ** Summarize a validateOTP response for logging - the full response carries a
// large items array (every billing period's PDF), which is noise in both local
// runs and CloudWatch. Only success, errors, token presence and item count/slug
// are printed.
export function summarizeOtpResponse(response) {
  const { success, errors, data } = response ?? {};
  const inner = data ?? {};
  const items = inner.items ?? data?.data?.items ?? [];
  return JSON.stringify({
    success,
    errors,
    hasToken: Boolean(
      inner.token ?? inner.session_token ?? inner.sessionToken
    ),
    itemCount: items.length,
    firstItemSlug: items[0]?.slug,
  });
}

// ** Helper: current period + file name used for the S3 object
// File name always uses the last day of the month as the day
// (e.g. SOA-2026-09-30.pdf).
export function soaFileNames() {
  const now = new Date();
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return {
    month: `${yyyy}-${mm}`,
    fileName: `SOA-${yyyy}-${mm}-${lastDayOfMonth.getDate()}.pdf`,
  };
}

// ** Pull minimal encryption metadata out of a PDF so unlock failures can be
// diagnosed: wrong PDF_PASSWORD vs an encryption pdf-lib cannot handle
// (e.g. AES-256 /V 5, /R 5 or 6).
export function inspectPdfEncryption(bytes) {
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

// ** Extract 6-char OTP codes from a Gmail message subject and decoded body
// Returns a deduped array of codes. The subject always carries the code
// (e.g. "Your Converge Confirmation Code: 3DOJS4").
export function extractOtpCandidates(subject, body) {
  const candidates = [
    /Confirmation Code:?\s*([A-Z0-9]{6})/i.exec(subject)?.[1],
    /Your Confirmation Code:\s*([A-Z0-9]{6})/.exec(body)?.[1],
    body.match(/\b[A-Z0-9]{6}\b/)?.[0],
  ];
  const codes = [];
  for (const candidate of candidates) {
    if (candidate) codes.push(candidate);
  }
  return [...new Set(codes)];
}

// ** Decode (base64url) the text of a Gmail message payload
// Gmail messages can be nested multipart structures, so walk every part and
// collect all text/* bodies (plain-text and HTML), then join them for scanning.
export function decodeMessageBody(payload) {
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