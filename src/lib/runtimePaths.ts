import path from "node:path";

const ENV_USER_DATA_DIR = "SHEET2SOCIAL_USER_DATA_DIR";
const ENV_STORAGE_DIR = "SHEET2SOCIAL_STORAGE_DIR";
const ENV_DATA_DIR = "SHEET2SOCIAL_DATA_DIR";
const ENV_CSV_DIR = "SHEET2SOCIAL_CSV_DIR";
const ENV_IMAGE_DIR = "SHEET2SOCIAL_IMAGE_DIR";
const ENV_TRACE_DIR = "SHEET2SOCIAL_TRACE_DIR";
const DEFAULT_STORAGE_DIR = "storage";
const DEFAULT_DATA_DIR = "data";
const DEFAULT_CSV_DIR = path.join(DEFAULT_DATA_DIR, "csvs");
const DEFAULT_IMAGE_DIR = path.join(DEFAULT_DATA_DIR, "images");
const DEFAULT_TRACE_DIR = path.join("public", "automation-trace");

function getEnvDir(key: string): string | undefined {
  const value = String(process.env[key] ?? "").trim();
  return value.length > 0 ? value : undefined;
}

export function isUserDataRuntime(): boolean {
  return Boolean(
    getEnvDir(ENV_USER_DATA_DIR) ||
      getEnvDir(ENV_STORAGE_DIR) ||
      getEnvDir(ENV_DATA_DIR) ||
      getEnvDir(ENV_CSV_DIR) ||
      getEnvDir(ENV_IMAGE_DIR) ||
      getEnvDir(ENV_TRACE_DIR)
  );
}

export function getRuntimeStorageDir(): string {
  return getEnvDir(ENV_STORAGE_DIR) ?? DEFAULT_STORAGE_DIR;
}

export function getRuntimeDataDir(): string {
  return getEnvDir(ENV_DATA_DIR) ?? DEFAULT_DATA_DIR;
}

export function getRuntimeCsvDir(): string {
  return getEnvDir(ENV_CSV_DIR) ?? DEFAULT_CSV_DIR;
}

export function getRuntimeImageDir(): string {
  return getEnvDir(ENV_IMAGE_DIR) ?? DEFAULT_IMAGE_DIR;
}

export function getRuntimeTraceDir(): string {
  return getEnvDir(ENV_TRACE_DIR) ?? DEFAULT_TRACE_DIR;
}
