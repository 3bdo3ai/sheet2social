import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

const SESSION_STORE_PATH = path.join(
  process.cwd(),
  "storage",
  "facebook_sessions.json"
);

export const runtime = "nodejs";

type SessionStore = Record<string, unknown[]>;

async function readStore(): Promise<SessionStore> {
  try {
    const raw = await fs.readFile(SESSION_STORE_PATH, "utf8");
    return (JSON.parse(raw) as SessionStore) ?? {};
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("accountId")?.trim();

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const store = await readStore();
  const hasSession = Array.isArray(store[accountId]) && store[accountId].length > 0;

  return NextResponse.json({ accountId, hasSession });
}
