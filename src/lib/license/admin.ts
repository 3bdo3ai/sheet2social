import "server-only";

import { generateLicenseKey } from "@/lib/license/keygen";
import type { LicenseKeyRow, LicenseStatus, LicenseSummary } from "@/lib/license/types";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const DEFAULT_DURATION_DAYS = 30;
const EXPIRING_WINDOW_DAYS = 7;

function getAdminKeySet(): Set<string> {
  const raw = process.env.LICENSE_ADMIN_KEYS?.trim();

  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function isAdminKeyString(keyString: string): boolean {
  return getAdminKeySet().has(keyString);
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const intValue = Math.floor(value);
  if (intValue <= 0) {
    return null;
  }

  return intValue;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIsoDate(input: string): string {
  const parsed = new Date(input);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid date value.");
  }

  return parsed.toISOString();
}

async function expirePastDueLicenses(): Promise<void> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("license_keys")
    .select("id,key_string")
    .in("status", ["active", "paused"])
    .lt("valid_until", new Date().toISOString());

  if (error) {
    throw error;
  }

  const targetIds = (data ?? [])
    .filter((row) => !isAdminKeyString(row.key_string))
    .map((row) => row.id);

  if (targetIds.length === 0) {
    return;
  }

  const { error: updateError } = await client
    .from("license_keys")
    .update({ status: "expired" })
    .in("id", targetIds);

  if (updateError) {
    throw updateError;
  }
}

async function countByFilter(filter: (builder: ReturnType<ReturnType<typeof getSupabaseAdminClient>["from"]>) => unknown): Promise<number> {
  const client = getSupabaseAdminClient();
  const builder = client.from("license_keys").select("id", { count: "exact", head: true });
  await filter(builder as never);
  const { count, error } = await (builder as never);

  if (error) {
    throw error;
  }

  return count ?? 0;
}

async function ensureUniqueGeneratedKey(maxAttempts = 10): Promise<string> {
  const client = getSupabaseAdminClient();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateLicenseKey();
    const { data, error } = await client
      .from("license_keys")
      .select("id")
      .eq("key_string", candidate)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      throw error;
    }

    if (!data) {
      return candidate;
    }
  }

  throw new Error("Unable to generate a unique key after multiple attempts.");
}

export async function getLicenseSummary(): Promise<LicenseSummary> {
  await expirePastDueLicenses();

  const client = getSupabaseAdminClient();
  const now = new Date();
  const soon = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [activeRes, pausedRes, expiringRes, devicesRes] = await Promise.all([
    client.from("license_keys").select("id", { count: "exact", head: true }).eq("status", "active"),
    client.from("license_keys").select("id", { count: "exact", head: true }).eq("status", "paused"),
    client
      .from("license_keys")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .gte("valid_until", now.toISOString())
      .lte("valid_until", soon.toISOString()),
    client
      .from("license_keys")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .not("device_id", "is", null),
  ]);

  if (activeRes.error) throw activeRes.error;
  if (pausedRes.error) throw pausedRes.error;
  if (expiringRes.error) throw expiringRes.error;
  if (devicesRes.error) throw devicesRes.error;

  return {
    totalActive: activeRes.count ?? 0,
    expiringSoon: expiringRes.count ?? 0,
    totalPaused: pausedRes.count ?? 0,
    totalDevicesConnected: devicesRes.count ?? 0,
  };
}

export async function listLicenseKeys(input: {
  status?: LicenseStatus | "all";
  search?: string;
  sortBy?: "created_at" | "valid_until" | "status" | "key_string";
  sortOrder?: "asc" | "desc";
}): Promise<LicenseKeyRow[]> {
  await expirePastDueLicenses();

  const status = input.status ?? "all";
  const sortBy = input.sortBy ?? "created_at";
  const sortOrder = input.sortOrder ?? "desc";

  const client = getSupabaseAdminClient();
  let query = client.from("license_keys").select("*");

  if (status !== "all") {
    query = query.eq("status", status);
  }

  if (input.search?.trim()) {
    const escaped = input.search.trim().replace(/,/g, " ");
    query = query.or(
      `key_string.ilike.%${escaped}%,user_name.ilike.%${escaped}%,user_email.ilike.%${escaped}%,user_phone.ilike.%${escaped}%`,
    );
  }

  const { data, error } = await query.order(sortBy, { ascending: sortOrder === "asc" }).limit(1000);

  if (error) {
    throw error;
  }

  const rows = (data as LicenseKeyRow[] | null) ?? [];
  return rows.map((row) => ({
    ...row,
    is_admin: isAdminKeyString(row.key_string),
  }));
}

export async function createLicenseRecord(input: {
  durationDays?: number;
  validUntil?: string;
  userName?: string;
  userPhone?: string;
  userEmail?: string;
  adminNotes?: string;
}): Promise<LicenseKeyRow> {
  const durationDays = parsePositiveInteger(input.durationDays) ?? DEFAULT_DURATION_DAYS;

  const validUntil = input.validUntil
    ? toIsoDate(input.validUntil)
    : new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

  const keyString = await ensureUniqueGeneratedKey();
  const client = getSupabaseAdminClient();

  const { data, error } = await client
    .from("license_keys")
    .insert({
      key_string: keyString,
      status: "active",
      valid_until: validUntil,
      user_name: normalizeOptionalText(input.userName),
      user_phone: normalizeOptionalText(input.userPhone),
      user_email: normalizeOptionalText(input.userEmail),
      admin_notes: normalizeOptionalText(input.adminNotes),
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as LicenseKeyRow;
}

export async function extendLicenseRecord(input: {
  id: string;
  addDays?: number;
  validUntil?: string;
}): Promise<LicenseKeyRow> {
  const client = getSupabaseAdminClient();

  const { data: current, error: currentError } = await client
    .from("license_keys")
    .select("*")
    .eq("id", input.id)
    .single();

  if (currentError) {
    throw currentError;
  }

  const currentRow = current as LicenseKeyRow;
  if (isAdminKeyString(currentRow.key_string)) {
    throw new Error("Admin keys are non-expiring and cannot be extended.");
  }

  const now = Date.now();
  const currentExpiry = new Date(currentRow.valid_until).getTime();
  const baseline = Number.isNaN(currentExpiry) ? now : Math.max(currentExpiry, now);

  let nextValidUntil: string;
  if (input.validUntil) {
    nextValidUntil = toIsoDate(input.validUntil);
  } else {
    const addDays = parsePositiveInteger(input.addDays);
    if (!addDays) {
      throw new Error("Either addDays or validUntil must be provided.");
    }

    nextValidUntil = new Date(baseline + addDays * 24 * 60 * 60 * 1000).toISOString();
  }

  const nextStatus: LicenseStatus =
    currentRow.status === "expired" && new Date(nextValidUntil).getTime() > now ? "active" : currentRow.status;

  const { data, error } = await client
    .from("license_keys")
    .update({
      valid_until: nextValidUntil,
      status: nextStatus,
    })
    .eq("id", input.id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as LicenseKeyRow;
}

export async function setLicenseStatus(input: {
  id: string;
  status: LicenseStatus;
}): Promise<LicenseKeyRow> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("license_keys")
    .update({ status: input.status })
    .eq("id", input.id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as LicenseKeyRow;
}

export async function forceLogoutLicenseDevice(id: string): Promise<LicenseKeyRow> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("license_keys")
    .update({ device_id: null })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as LicenseKeyRow;
}

export async function deleteLicenseRecord(id: string): Promise<void> {
  const client = getSupabaseAdminClient();
  const { error } = await client.from("license_keys").delete().eq("id", id);

  if (error) {
    throw error;
  }
}
