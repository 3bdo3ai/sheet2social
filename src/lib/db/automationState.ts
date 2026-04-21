import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimeStorageDir } from "@/lib/runtimePaths";

export type AutomationState = "running" | "stopped";

export interface AutomationSettings {
  parallelAccounts: number;
  waitIntervalMinutes: number;
  delayBetweenAccountsMinutes: number;
  postsPerGroup: number;
  maxPostsPerAccountPerCycle: number;
  postsPerSession: number;
  commentWithPostImage: boolean;
  proxyRotationEnabled: boolean;
}

export interface AutomationStateRecord {
  state: AutomationState;
  settings: AutomationSettings;
  updatedAt: string;
}

const STORAGE_DIR = getRuntimeStorageDir();
const AUTOMATION_STATE_PATH = path.join(STORAGE_DIR, "automation_state.json");
const DEFAULT_AUTOMATION_STATE: AutomationStateRecord = {
  state: "stopped",
  settings: {
    parallelAccounts: 3,
    waitIntervalMinutes: 5,
    delayBetweenAccountsMinutes: 1,
    postsPerGroup: 1,
    maxPostsPerAccountPerCycle: 10,
    postsPerSession: 20,
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
    const normalizedParallelAccounts = Math.max(
      1,
      Math.floor(
        typeof rawSettings?.parallelAccounts === "number"
          ? rawSettings.parallelAccounts
          : DEFAULT_AUTOMATION_STATE.settings.parallelAccounts
      )
    );
    const normalizedWaitIntervalMinutes = Math.max(
      1,
      Math.floor(
        typeof rawSettings?.waitIntervalMinutes === "number"
          ? rawSettings.waitIntervalMinutes
          : DEFAULT_AUTOMATION_STATE.settings.waitIntervalMinutes
      )
    );
    const normalizedDelayBetweenAccountsMinutes = Math.max(
      0,
      Math.floor(
        typeof rawSettings?.delayBetweenAccountsMinutes === "number"
          ? rawSettings.delayBetweenAccountsMinutes
          : DEFAULT_AUTOMATION_STATE.settings.delayBetweenAccountsMinutes
      )
    );
    const normalizedPostsPerGroup = Math.max(
      1,
      Math.floor(
        typeof rawSettings?.postsPerGroup === "number"
          ? rawSettings.postsPerGroup
          : DEFAULT_AUTOMATION_STATE.settings.postsPerGroup
      )
    );
    const normalizedMaxPostsPerAccountPerCycle = Math.max(
      1,
      Math.floor(
        typeof rawSettings?.maxPostsPerAccountPerCycle === "number"
          ? rawSettings.maxPostsPerAccountPerCycle
          : DEFAULT_AUTOMATION_STATE.settings.maxPostsPerAccountPerCycle
      )
    );
    const fallbackPostsPerSession =
      normalizedParallelAccounts * normalizedMaxPostsPerAccountPerCycle;

    return {
      state: parsed.state,
      settings:
        rawSettings && typeof rawSettings === "object"
          ? {
              parallelAccounts: normalizedParallelAccounts,
              waitIntervalMinutes: normalizedWaitIntervalMinutes,
              delayBetweenAccountsMinutes: normalizedDelayBetweenAccountsMinutes,
              postsPerGroup: normalizedPostsPerGroup,
              maxPostsPerAccountPerCycle: normalizedMaxPostsPerAccountPerCycle,
              postsPerSession: Math.max(
                1,
                Math.floor(
                  typeof rawSettings.postsPerSession === "number"
                    ? rawSettings.postsPerSession
                    : fallbackPostsPerSession
                )
              ),
              commentWithPostImage:
                typeof rawSettings.commentWithPostImage === "boolean"
                  ? rawSettings.commentWithPostImage
                  : DEFAULT_AUTOMATION_STATE.settings.commentWithPostImage,
              proxyRotationEnabled:
                typeof rawSettings.proxyRotationEnabled === "boolean"
                  ? rawSettings.proxyRotationEnabled
                  : DEFAULT_AUTOMATION_STATE.settings.proxyRotationEnabled,
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
  const parallelAccounts = Math.max(
    1,
    Math.floor(settings.parallelAccounts ?? current.settings.parallelAccounts)
  );
  const maxPostsPerAccountPerCycle = Math.max(
    1,
    Math.floor(
      settings.maxPostsPerAccountPerCycle ??
        current.settings.maxPostsPerAccountPerCycle
    )
  );

  const nextSettings: AutomationSettings = {
    parallelAccounts,
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
    maxPostsPerAccountPerCycle,
    postsPerSession: Math.max(
      1,
      Math.floor(
        settings.postsPerSession ??
          current.settings.postsPerSession ??
          parallelAccounts * maxPostsPerAccountPerCycle
      )
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
