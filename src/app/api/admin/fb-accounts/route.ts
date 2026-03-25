import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  appendParquetRecords,
  deleteParquetRecords,
  initializeDbStorage,
  readParquetRecords,
  writeParquetRecords,
} from "@/lib/db";
import type { FbAccount } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  await initializeDbStorage();
  const records = await readParquetRecords("fbAccounts");
  return NextResponse.json(records);
}

export async function POST(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as Partial<FbAccount>;
  const name = payload.name?.trim();
  const alias = payload.alias?.trim();
  const username = payload.username?.trim();
  const password = payload.password?.trim();
  const socks5ProxyHost = payload.socks5ProxyHost?.trim() || undefined;
  const rawProxyPort = Number(payload.socks5ProxyPort);
  const socks5ProxyPort = Number.isFinite(rawProxyPort) && rawProxyPort > 0 ? rawProxyPort : undefined;

  if (!name || !username || !password) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const record: FbAccount = {
    id: randomUUID(),
    name,
    alias,
    username,
    password,
    socks5ProxyHost,
    socks5ProxyPort,
    postFilter: "all",
    postingMethod: "post-all-sequential",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  await appendParquetRecords("fbAccounts", [record]);
  return NextResponse.json(record, { status: 201 });
}

export async function PUT(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as Partial<FbAccount> & { id?: string };
  const id = payload.id?.trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const current = await readParquetRecords("fbAccounts");
  const index = current.findIndex((item) => item.id === id);

  if (index < 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const updated = {
    ...current[index],
    postFilter: payload.postFilter ?? current[index].postFilter,
    postingMethod: payload.postingMethod ?? current[index].postingMethod,
    isActive: payload.isActive ?? current[index].isActive,
    alias: payload.alias ?? current[index].alias,
    updatedAt: new Date().toISOString(),
  };

  current[index] = updated;
  await writeParquetRecords("fbAccounts", current);

  return NextResponse.json(updated);
}

export async function DELETE(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as { id?: string };
  const id = payload.id?.trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const result = await deleteParquetRecords("fbAccounts", (record) => record.id === id);

  if (result.deletedCount === 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, deletedCount: result.deletedCount });
}
