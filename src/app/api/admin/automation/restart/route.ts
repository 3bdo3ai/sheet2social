import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

import { readAutomationState, writeAutomationState } from "@/lib/db";

export const runtime = "nodejs";

const WORKER_LOCK_PATH = path.join(process.cwd(), "storage", "worker.lock");

async function terminateWorkerFromLock(): Promise<number | null> {
  try {
    const raw = (await fs.readFile(WORKER_LOCK_PATH, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);

    if (!Number.isInteger(pid) || pid <= 0) {
      await fs.rm(WORKER_LOCK_PATH, { force: true }).catch(() => undefined);
      return null;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may already be gone; continue clearing stale lock.
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 250));
      } catch {
        break;
      }
    }

    await fs.rm(WORKER_LOCK_PATH, { force: true }).catch(() => undefined);
    return pid;
  } catch {
    return null;
  }
}

export async function POST() {
  const current = await readAutomationState();
  const terminatedWorkerPid = await terminateWorkerFromLock();

  await writeAutomationState("stopped");
  await new Promise((resolve) => setTimeout(resolve, 900));
  const next = await writeAutomationState("running");

  return NextResponse.json({
    ok: true,
    previousState: current.state,
    state: next.state,
    updatedAt: next.updatedAt,
    terminatedWorkerPid,
  });
}
