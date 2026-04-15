import { createHmac, timingSafeEqual } from "node:crypto";

import { LICENSE_SESSION_COOKIE } from "@/lib/license/constants";
import type { LicenseSessionPayload } from "@/lib/license/types";

function getSessionSecret(): string {
  const secret = process.env.LICENSE_SESSION_SECRET?.trim();

  if (!secret) {
    throw new Error("Missing required environment variable: LICENSE_SESSION_SECRET");
  }

  return secret;
}

function signRawToken(rawPayload: string): string {
  return createHmac("sha256", getSessionSecret()).update(rawPayload).digest("base64url");
}

export function signLicenseSession(payload: LicenseSessionPayload): string {
  const rawPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signRawToken(rawPayload);

  return `${rawPayload}.${signature}`;
}

export function verifyLicenseSession(token: string): LicenseSessionPayload | null {
  const [rawPayload, signature] = token.split(".");

  if (!rawPayload || !signature) {
    return null;
  }

  const expectedSignature = signRawToken(rawPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf8")) as LicenseSessionPayload;

    if (!decoded.licenseId || !decoded.keyString || !decoded.deviceId) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}
