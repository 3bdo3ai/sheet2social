import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";

import { generateLicenseKey } from "../src/lib/license/keygen";
import type { Database } from "../src/lib/supabase/types";

const ADMIN_NON_EXPIRING_VALID_UNTIL = "9999-12-31T23:59:59.999Z";

type CliArgs = {
  days: number;
  validUntil?: string;
  userName?: string;
  userPhone?: string;
  userEmail?: string;
  adminNotes?: string;
  force: boolean;
  skipEnvUpdate: boolean;
  redactKey: boolean;
  envFile: string;
};

function parseArgs(argv: string[]): CliArgs {
  const result: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      continue;
    }

    const separatorIndex = value.indexOf("=");
    if (separatorIndex > 0) {
      result[value.slice(2, separatorIndex)] = value.slice(separatorIndex + 1);
      continue;
    }

    const key = value.slice(2);
    const nextValue = argv[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      result[key] = nextValue;
      index += 1;
    } else {
      result[key] = true;
    }
  }

  const daysValue = typeof result.days === "string" ? Number.parseInt(result.days, 10) : 365;

  return {
    days: Number.isFinite(daysValue) && daysValue > 0 ? daysValue : 365,
    validUntil: typeof result["valid-until"] === "string" ? result["valid-until"].trim() : undefined,
    userName: typeof result.name === "string" ? result.name.trim() : undefined,
    userPhone: typeof result.phone === "string" ? result.phone.trim() : undefined,
    userEmail: typeof result.email === "string" ? result.email.trim() : undefined,
    adminNotes: typeof result.notes === "string" ? result.notes.trim() : undefined,
    force: result.force === true,
    skipEnvUpdate: result["no-env-update"] === true,
    redactKey: result["redact-key"] === true,
    envFile: typeof result["env-file"] === "string" && result["env-file"].trim().length > 0 ? result["env-file"].trim() : ".env.local",
  };
}

function formatKeyForOutput(key: string, redact: boolean): string {
  if (!redact || key.length <= 8) {
    return key;
  }

  const prefix = key.slice(0, 4);
  const suffix = key.slice(-4);
  return `${prefix}${"*".repeat(key.length - 8)}${suffix}`;
}

function parseEnvContent(content: string): Record<string, string> {
  const output: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    output[key] = value;
  }

  return output;
}

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, "utf8");
  const parsed = parseEnvContent(content);

  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] = value;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function splitAdminKeys(rawValue: string | undefined): string[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return [];
  }

  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function upsertEnvValue(filePath: string, key: string, value: string): void {
  const nextLine = `${key}=${value}`;

  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${nextLine}\n`, "utf8");
    return;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const keyPrefixPattern = new RegExp(`^\\s*${key}\\s*=`);

  let replaced = false;
  const updatedLines = lines.map((line) => {
    if (keyPrefixPattern.test(line)) {
      replaced = true;
      return nextLine;
    }

    return line;
  });

  if (!replaced) {
    if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1].trim().length > 0) {
      updatedLines.push("");
    }

    updatedLines.push(nextLine);
  }

  const normalized = `${updatedLines.join("\n").replace(/\n+$/g, "")}\n`;
  writeFileSync(filePath, normalized, "utf8");
}

function toIsoDate(days: number, explicitDate?: string): string {
  if (explicitDate) {
    const parsed = new Date(explicitDate);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("Invalid value for --valid-until. Use an ISO date/time string.");
    }

    return parsed.toISOString();
  }

  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function ensureUniqueKey(client: ReturnType<typeof createClient<Database>>, maxAttempts = 20): Promise<string> {
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

  throw new Error("Unable to generate a unique license key after multiple attempts.");
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const envPath = path.resolve(rootDir, args.envFile);

  loadEnvFile(path.resolve(rootDir, ".env"));
  loadEnvFile(envPath);

  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const existingAdminKeys = splitAdminKeys(process.env.LICENSE_ADMIN_KEYS);
  if (existingAdminKeys.length > 0 && !args.force) {
    console.log("[bootstrap] LICENSE_ADMIN_KEYS already has one or more keys.");
    console.log("[bootstrap] Use --force if you intentionally want to add another admin key.");
    return;
  }

  const client = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const validUntil = ADMIN_NON_EXPIRING_VALID_UNTIL;
  const keyString = await ensureUniqueKey(client);

  const { data, error } = await client
    .from("license_keys")
    .insert({
      key_string: keyString,
      status: "active",
      valid_until: validUntil,
      user_name: args.userName ?? "Primary Admin",
      user_phone: args.userPhone ?? null,
      user_email: args.userEmail ?? null,
      admin_notes:
        args.adminNotes ?? `Bootstrapped admin non-expiring key on ${new Date().toISOString()}`,
    })
    .select("id,key_string,status,valid_until")
    .single();

  if (error) {
    throw error;
  }

  if (!args.skipEnvUpdate) {
    const nextAdminKeys = Array.from(new Set([...existingAdminKeys, keyString]));
    upsertEnvValue(envPath, "LICENSE_ADMIN_KEYS", nextAdminKeys.join(","));
  }

  console.log("[bootstrap] Admin license key created successfully.");
  console.log(`[bootstrap] Non-expiring admin key; valid_until forced to ${ADMIN_NON_EXPIRING_VALID_UNTIL}`);
  console.log(`[bootstrap] Key: ${formatKeyForOutput(data.key_string, args.redactKey)}`);
  console.log(`[bootstrap] Status: ${data.status}`);
  console.log(`[bootstrap] Valid Until (UTC): ${data.valid_until}`);
  if (args.skipEnvUpdate) {
    console.log("[bootstrap] .env update skipped (--no-env-update). Add this key to LICENSE_ADMIN_KEYS manually.");
  } else {
    console.log(`[bootstrap] Updated ${args.envFile} with LICENSE_ADMIN_KEYS.`);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[bootstrap] Failed: ${message}`);
  process.exitCode = 1;
});
