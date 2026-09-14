import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (one level up from src/)
const envPath = join(__dirname, "..", ".env");
const envContent = readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  if (key) process.env[key] = value;
}

const event = JSON.parse(readFileSync(join(__dirname, "..", "events", "event.json"), "utf-8"));

const { handler } = await import("./index.mjs");

// Spinner (stderr so it doesn't garble the handler's stdout logs) shown while
// the handler awaits network calls - the OTP email alone can take ~60s.
const frames = ["|", "/", "-", "\\"];
let frame = 0;
const spinner = setInterval(() => {
  process.stderr.write(`\rWorking... ${frames[frame % frames.length]} `);
  frame += 1;
}, 150);

try {
  const result = await handler(event, {});
  if (typeof result?.body === "string") {
    try {
      result.body = JSON.parse(result.body);
    } catch {
      /* leave as-is if the body is not JSON */
    }
  }
  clearInterval(spinner);
  process.stderr.write("\r");
  console.log("RESULT:", JSON.stringify(result, null, 2));
} catch (error) {
  clearInterval(spinner);
  process.stderr.write("\r");
  console.error("HANDLER FAILED:", error.message);
  process.exit(1);
}
