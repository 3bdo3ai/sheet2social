import { createHmac } from "node:crypto";

export type TwoFactorSource = "code" | "secret";

export type TwoFactorInputParseResult =
  | { state: "missing" }
  | { state: "invalid"; message: string }
  | { state: "ready"; source: TwoFactorSource; codes: string[] };

function decodeBase32Secret(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleanSecret = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleanSecret) {
    const index = alphabet.indexOf(char);
    if (index < 0) {
      continue;
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotpCode(secret: string, timeMs = Date.now()): string {
  const key = decodeBase32Secret(secret);
  if (key.length === 0) {
    throw new Error("The 2FA secret could not be decoded.");
  }

  const counter = Math.floor(timeMs / 30_000);
  const buffer = Buffer.alloc(8);

  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter & 0xffffffff, 4);

  const hmac = createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, "0");
}

function extractSecretFromOtpAuthUri(rawValue: string): string | undefined {
  if (!rawValue.toLowerCase().startsWith("otpauth://")) {
    return undefined;
  }

  try {
    const parsed = new URL(rawValue);
    const secret = parsed.searchParams.get("secret")?.trim();
    return secret || undefined;
  } catch {
    return undefined;
  }
}

function normalizeBase32Secret(rawSecret: string): string {
  return rawSecret
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/=+$/g, "");
}

function isDirectSixDigitCode(rawValue: string): string | undefined {
  const digitsOnly = rawValue.replace(/\D/g, "");
  const hasOnlyDigitsAndSeparators = rawValue.replace(/[0-9\s-]/g, "").length === 0;

  if (digitsOnly.length === 6 && hasOnlyDigitsAndSeparators) {
    return digitsOnly;
  }

  return undefined;
}

function uniqueCodes(codes: string[]): string[] {
  return Array.from(new Set(codes));
}

export function parseTwoFactorInput(
  rawInput: string | undefined,
  timeMs = Date.now()
): TwoFactorInputParseResult {
  const normalizedInput = String(rawInput ?? "").trim();
  if (!normalizedInput) {
    return { state: "missing" };
  }

  const directCode = isDirectSixDigitCode(normalizedInput);
  if (directCode) {
    return {
      state: "ready",
      source: "code",
      codes: [directCode],
    };
  }

  const fromOtpAuth = extractSecretFromOtpAuthUri(normalizedInput);
  const secretCandidate = normalizeBase32Secret(fromOtpAuth ?? normalizedInput);

  if (!/^[A-Z2-7]+$/.test(secretCandidate) || secretCandidate.length < 10) {
    return {
      state: "invalid",
      message:
        "Invalid 2FA value. Enter either a 6-digit authentication code or a valid Base32 2FA secret.",
    };
  }

  try {
    const codes = uniqueCodes([
      generateTotpCode(secretCandidate, timeMs),
      generateTotpCode(secretCandidate, timeMs - 30_000),
      generateTotpCode(secretCandidate, timeMs + 30_000),
    ]);

    return {
      state: "ready",
      source: "secret",
      codes,
    };
  } catch {
    return {
      state: "invalid",
      message:
        "Invalid 2FA secret. Verify the secret key and try again.",
    };
  }
}
