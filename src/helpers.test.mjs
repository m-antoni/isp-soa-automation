import { describe, expect, it, vi, afterEach } from "vitest";
import {
  soaFileNames,
  decodeMessageBody,
  extractOtpCandidates,
} from "./helpers.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("soaFileNames", () => {
  it("returns month and file name for a mid-month date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    expect(soaFileNames()).toEqual({
      month: "2026-09",
      fileName: "SOA-2026-09-30.pdf",
    });
  });

  it("uses 29 days for February in a leap year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2028-02-15T10:00:00Z"));
    const { month, fileName } = soaFileNames();
    expect(month).toBe("2028-02");
    expect(fileName).toBe("SOA-2028-02-29.pdf");
  });
});

describe("extractOtpCandidates", () => {
  it("extracts the code from a standard Converge subject", () => {
    const subject = "Your Converge Confirmation Code: 3DOJS4";
    expect(extractOtpCandidates(subject, "")).toEqual(["3DOJS4"]);
  });

  it("deduplicates a code found in both subject and body", () => {
    const subject = "Confirmation Code: 123456";
    const body = "Your code is 123456";
    expect(extractOtpCandidates(subject, body)).toEqual(["123456"]);
  });

  it("returns empty array when no code is present", () => {
    expect(extractOtpCandidates("no code here", "nothing either")).toEqual([]);
  });
});

describe("decodeMessageBody", () => {
  function toBase64url(str) {
    return Buffer.from(str)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  it("joins text parts in order across a nested multipart structure", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          parts: [
            { mimeType: "text/plain", body: { data: toBase64url("First") } },
          ],
        },
        { mimeType: "text/html", body: { data: toBase64url("<b>Second</b>") } },
      ],
    };
    expect(decodeMessageBody(payload)).toBe("First\n<b>Second</b>");
  });
});