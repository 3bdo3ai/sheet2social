import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

export type AutomationState = "running" | "stopped";

export interface AutomationSettings {
  parallelAccounts: number;
  waitIntervalMinutes: number;
  delayBetweenAccountsMinutes: number;
  postsPerGroup: number;
  commentWithPostImage: boolean;
  proxyRotationEnabled: boolean;
}

export interface AutomationStateRecord {
  state: AutomationState;
  settings: AutomationSettings;
  updatedAt: string;
}

const STORAGE_DIR = path.join(process.cwd(), "storage");
const AUTOMATION_STATE_PATH = path.join(STORAGE_DIR, "automation_state.json");
const DEFAULT_AUTOMATION_STATE: AutomationStateRecord = {
  state: "stopped",
  settings: {
    parallelAccounts: 3,
    waitIntervalMinutes: 5,
    delayBetweenAccountsMinutes: 1,
    postsPerGroup: 1,
    commentWithPostImage: false,
    proxyRotationEnabled: false,
  },
  updatedAt: new Date(0).toISOString(),
};

async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

async function persistAutomationState(
  record: AutomationStateRecord
): Promise<void> {
  await fs.writeFile(
    AUTOMATION_STATE_PATH,
    JSON.stringify(record, null, 2),
    "utf8"
  );
}

export async function readAutomationState(): Promise<AutomationStateRecord> {
  await ensureStorageDir();

  try {
    const rawContent = await fs.readFile(AUTOMATION_STATE_PATH, "utf8");
    const parsed = JSON.parse(rawContent) as Partial<AutomationStateRecord>;

    if (parsed.state !== "running" && parsed.state !== "stopped") {
      return DEFAULT_AUTOMATION_STATE;
    }

    const rawSettings = parsed.settings;
    const hasValidSettings =
      rawSettings &&
      typeof rawSettings.waitIntervalMinutes === "number" &&
      typeof rawSettings.delayBetweenAccountsMinutes === "number" &&
      typeof rawSettings.postsPerGroup === "number" &&
      typeof rawSettings.parallelAccounts === "number" &&
      typeof rawSettings.commentWithPostImage === "boolean" &&
      typeof rawSettings.proxyRotationEnabled === "boolean";

    return {
      state: parsed.state,
      settings: hasValidSettings
        ? {
            waitIntervalMinutes: Math.max(
              1,
              Math.floor(rawSettings.waitIntervalMinutes)
            ),
            delayBetweenAccountsMinutes: Math.max(
              0,
              Math.floor(rawSettings.delayBetweenAccountsMinutes)
            ),
            postsPerGroup: Math.max(1, Math.floor(rawSettings.postsPerGroup)),
            parallelAccounts: Math.max(
              1,
              Math.floor(rawSettings.parallelAccounts)
            ),
            commentWithPostImage: rawSettings.commentWithPostImage,
            proxyRotationEnabled: rawSettings.proxyRotationEnabled,
          }
        : DEFAULT_AUTOMATION_STATE.settings,
      updatedAt: parsed.updatedAt ?? DEFAULT_AUTOMATION_STATE.updatedAt,
    };
  } catch {
    await persistAutomationState(DEFAULT_AUTOMATION_STATE);
    return DEFAULT_AUTOMATION_STATE;
  }
}

export async function writeAutomationState(
  state: AutomationState
): Promise<AutomationStateRecord> {
  await ensureStorageDir();

  const current = await readAutomationState();

  const nextState: AutomationStateRecord = {
    ...current,
    state,
    updatedAt: new Date().toISOString(),
  };

  await persistAutomationState(nextState);

  return nextState;
}

export async function writeAutomationSettings(
  settings: Partial<AutomationSettings>
): Promise<AutomationStateRecord> {
  await ensureStorageDir();

  const current = await readAutomationState();
  const nextSettings: AutomationSettings = {
    parallelAccounts: Math.max(
      1,
      Math.floor(settings.parallelAccounts ?? current.settings.parallelAccounts)
    ),
    waitIntervalMinutes: Math.max(
      1,
      Math.floor(
        settings.waitIntervalMinutes ?? current.settings.waitIntervalMinutes
      )
    ),
    delayBetweenAccountsMinutes: Math.max(
      0,
      Math.floor(
        settings.delayBetweenAccountsMinutes ??
          current.settings.delayBetweenAccountsMinutes
      )
    ),
    postsPerGroup: Math.max(
      1,
      Math.floor(settings.postsPerGroup ?? current.settings.postsPerGroup)
    ),
    commentWithPostImage:
      settings.commentWithPostImage ?? current.settings.commentWithPostImage,
    proxyRotationEnabled:
      settings.proxyRotationEnabled ?? current.settings.proxyRotationEnabled,
  };

  const nextState: AutomationStateRecord = {
    ...current,
    settings: nextSettings,
    updatedAt: new Date().toISOString(),
  };

  await persistAutomationState(nextState);

  return nextState;
}

export function getAutomationStatePath(): string {
  return AUTOMATION_STATE_PATH;
}
