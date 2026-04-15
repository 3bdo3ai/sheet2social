import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import { LICENSE_SESSION_COOKIE } from "@/lib/license/constants";
import { isLicenseKeyFormatValid } from "@/lib/license/keygen";
import { signLicenseSession, verifyLicenseSession } from "@/lib/license/session";
import type { LicenseKeyRow, LicenseSessionPayload, LicenseSessionView } from "@/lib/license/types";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 45;

type ValidationFailureReason =
  | "missing_session"
  | "invalid_session"
  | "invalid_key"
  | "expired"
  | "paused"
  | "revoked"
  | "device_mismatch"
  | "inactive";

export type SessionValidationResult =
  | {
      ok: true;
      session: LicenseSessionView;
      payload: LicenseSessionPayload;
    }
  | {
      ok: false;
      reason: ValidationFailureReason;
      message: string;
      statusCode: number;
    };

export class LicenseAuthError extends Error {
  constructor(
    public readonly code: ValidationFailureReason | "bad_request",
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

function getAdminKeySet(): Set<string> {
  const raw = process.env.LICENSE_ADMIN_KEYS?.trim();

  if (!raw) {
    return new Set();
  }

  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return new Set(values);
}

function isAdminKeyString(keyString: string): boolean {
  return getAdminKeySet().has(keyString);
}

function isNoRowsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCode = "code" in error ? (error as { code?: string }).code : undefined;
  return maybeCode === "PGRST116";
}

function normalizeKey(input: string): string {
  return input.trim();
}

function normalizeDeviceId(input: string): string {
  return input.trim();
}

function toSessionView(row: LicenseKeyRow, isAdmin: boolean): LicenseSessionView {
  const remainingMs = Math.max(0, new Date(row.valid_until).getTime() - Date.now());

  return {
    id: row.id,
    keyString: row.key_string,
    status: row.status,
    validUntil: row.valid_until,
    remainingMs,
    deviceId: row.device_id ?? "",
    isAdmin,
    userName: row.user_name,
    userPhone: row.user_phone,
    userEmail: row.user_email,
    adminNotes: row.admin_notes,
  };
}

async function getLicenseById(id: string): Promise<LicenseKeyRow | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client.from("license_keys").select("*").eq("id", id).maybeSingle();

  if (error && !isNoRowsError(error)) {
    throw error;
  }

  return (data as LicenseKeyRow | null) ?? null;
}

async function getLicenseByKeyString(keyString: string): Promise<LicenseKeyRow | null> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("license_keys")
    .select("*")
    .eq("key_string", keyString)
    .maybeSingle();

  if (error && !isNoRowsError(error)) {
    throw error;
  }

  return (data as LicenseKeyRow | null) ?? null;
}

async function markExpiredIfNeeded(row: LicenseKeyRow): Promise<LicenseKeyRow> {
  if (isAdminKeyString(row.key_string)) {
    return row;
  }

  const now = Date.now();
  const expiresAt = new Date(row.valid_until).getTime();

  if (Number.isNaN(expiresAt) || expiresAt > now || row.status === "expired" || row.status === "revoked") {
    return row;
  }

  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("license_keys")
    .update({ status: "expired" })
    .eq("id", row.id)
    .neq("status", "revoked")
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as LicenseKeyRow | null) ?? { ...row, status: "expired" };
}

function assertDeviceId(deviceId: string): void {
  if (!deviceId || deviceId.length < 16 || deviceId.length > 200) {
    throw new LicenseAuthError("bad_request", "A valid device fingerprint is required.");
  }
}

function assertLoginAllowed(row: LicenseKeyRow): void {
  if (row.status === "paused") {
    throw new LicenseAuthError("paused", "This key is currently paused.", 403);
  }

  if (row.status === "revoked") {
    throw new LicenseAuthError("revoked", "This key has been revoked.", 403);
  }

  if (row.status === "expired") {
    throw new LicenseAuthError("expired", "This key has expired.", 403);
  }

  if (row.status !== "active") {
    throw new LicenseAuthError("inactive", "This key is not active.", 403);
  }
}

async function bindDeviceIfNeeded(row: LicenseKeyRow, deviceId: string): Promise<LicenseKeyRow> {
  const client = getSupabaseAdminClient();

  if (!row.device_id) {
    const { data, error } = await client
      .from("license_keys")
      .update({ device_id: deviceId })
      .eq("id", row.id)
      .is("device_id", null)
      .select("*")
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (data) {
      return data as LicenseKeyRow;
    }

    const refreshed = await getLicenseById(row.id);
    if (!refreshed) {
      throw new LicenseAuthError("invalid_key", "License key not found.", 401);
    }

    if (refreshed.device_id && refreshed.device_id !== deviceId) {
      throw new LicenseAuthError(
        "device_mismatch",
        "Key is in use on another device. Please log out there first.",
        409,
      );
    }

    return refreshed;
  }

  if (row.device_id !== deviceId) {
    throw new LicenseAuthError(
      "device_mismatch",
      "Key is in use on another device. Please log out there first.",
      409,
    );
  }

  return row;
}

export async function createSessionForLicenseKey(keyInput: string, deviceInput: string) {
  const keyString = normalizeKey(keyInput);
  const deviceId = normalizeDeviceId(deviceInput);

  assertDeviceId(deviceId);

  if (!isLicenseKeyFormatValid(keyString)) {
    throw new LicenseAuthError("invalid_key", "License keys must be exactly 24 printable characters.", 400);
  }

  const found = await getLicenseByKeyString(keyString);
  if (!found) {
    throw new LicenseAuthError("invalid_key", "License key is invalid.", 401);
  }

  const withExpirySync = await markExpiredIfNeeded(found);
  assertLoginAllowed(withExpirySync);

  const isAdmin = isAdminKeyString(withExpirySync.key_string);
  if (!isAdmin) {
    const expiryMs = new Date(withExpirySync.valid_until).getTime();
    if (Number.isNaN(expiryMs) || expiryMs <= Date.now()) {
      await markExpiredIfNeeded(withExpirySync);
      throw new LicenseAuthError("expired", "This key has expired.", 403);
    }
  }

  const withDevice = await bindDeviceIfNeeded(withExpirySync, deviceId);
  const payload: LicenseSessionPayload = {
    licenseId: withDevice.id,
    keyString: withDevice.key_string,
    deviceId,
    isAdmin,
    issuedAt: Date.now(),
  };

  const token = signLicenseSession(payload);
  const session = toSessionView(withDevice, payload.isAdmin);

  return { token, session };
}

export function setLicenseSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    name: LICENSE_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearLicenseSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: LICENSE_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

function statusToFailure(status: LicenseKeyRow["status"]): {
  reason: ValidationFailureReason;
  message: string;
  statusCode: number;
} {
  if (status === "paused") {
    return { reason: "paused", message: "This key is paused.", statusCode: 403 };
  }

  if (status === "revoked") {
    return { reason: "revoked", message: "This key has been revoked.", statusCode: 403 };
  }

  if (status === "expired") {
    return { reason: "expired", message: "This key has expired.", statusCode: 403 };
  }

  return { reason: "inactive", message: "This key is inactive.", statusCode: 403 };
}

function validationFailure(reason: ValidationFailureReason, message: string, statusCode: number): SessionValidationResult {
  return {
    ok: false,
    reason,
    message,
    statusCode,
  };
}

export async function validateSessionFromCookies(): Promise<SessionValidationResult> {
  const cookieStore = await cookies();
  const token = cookieStore.get(LICENSE_SESSION_COOKIE)?.value;

  if (!token) {
    return validationFailure("missing_session", "No license session found.", 401);
  }

  const payload = verifyLicenseSession(token);

  if (!payload) {
    return validationFailure("invalid_session", "License session is invalid.", 401);
  }

  const row = await getLicenseById(payload.licenseId);

  if (!row || row.key_string !== payload.keyString) {
    return validationFailure("invalid_session", "Session no longer matches a license key.", 401);
  }

  const withExpirySync = await markExpiredIfNeeded(row);

  if (withExpirySync.status !== "active") {
    const statusInfo = statusToFailure(withExpirySync.status);
    return validationFailure(statusInfo.reason, statusInfo.message, statusInfo.statusCode);
  }

  if (!withExpirySync.device_id || withExpirySync.device_id !== payload.deviceId) {
    return validationFailure(
      "device_mismatch",
      "Key is in use on another device. Please log out there first.",
      409,
    );
  }

  const isAdmin = isAdminKeyString(withExpirySync.key_string);
  if (!isAdmin) {
    const expiresAt = new Date(withExpirySync.valid_until).getTime();
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
      await markExpiredIfNeeded(withExpirySync);
      return validationFailure("expired", "This key has expired.", 403);
    }
  }

  return {
    ok: true,
    payload,
    session: toSessionView(withExpirySync, isAdmin),
  };
}

export async function releaseCurrentDeviceBinding(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(LICENSE_SESSION_COOKIE)?.value;

  if (!token) {
    return;
  }

  const payload = verifyLicenseSession(token);

  if (!payload) {
    return;
  }

  const client = getSupabaseAdminClient();
  await client
    .from("license_keys")
    .update({ device_id: null })
    .eq("id", payload.licenseId)
    .eq("device_id", payload.deviceId);
}

export async function markCurrentSessionExpiredIfPastDue(): Promise<void> {
  const validation = await validateSessionFromCookies();

  if (!validation.ok) {
    return;
  }

  if (validation.session.isAdmin) {
    return;
  }

  const client = getSupabaseAdminClient();
  await client
    .from("license_keys")
    .update({ status: "expired" })
    .eq("id", validation.session.id)
    .eq("status", "active")
    .lte("valid_until", new Date().toISOString());
}

function buildLoginRedirect(reason: string): string {
  return `/login?reason=${encodeURIComponent(reason)}`;
}

export async function requireActiveLicenseSession(): Promise<LicenseSessionView> {
  const validation = await validateSessionFromCookies();

  if (!validation.ok) {
    redirect(buildLoginRedirect(validation.reason));
  }

  return validation.session;
}

export async function requireAdminLicenseSession(): Promise<LicenseSessionView> {
  const session = await requireActiveLicenseSession();

  if (!session.isAdmin) {
    redirect("/dashboard");
  }

  return session;
}
