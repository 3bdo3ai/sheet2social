import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  appendParquetRecords,
  deleteParquetRecords,
  initializeDbStorage,
  readParquetRecords,
  writeParquetRecords,
} from "@/lib/db";
import type { AutomationLog } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  await initializeDbStorage();

  const { searchParams } = new URL(request.url);
  const limit = Math.max(1, Number(searchParams.get("limit") ?? 150));

  let records: AutomationLog[] = [];
  try {
    records = await readParquetRecords("logs");
  } catch (error) {
    // During high-frequency writes, parquet reads can transiently fail; retry is handled
    // in the DB layer and this fallback keeps the UI from failing hard.
    console.error("[logs] Failed to read logs parquet", error);
    return NextResponse.json([]);
  }

  const latest = records.slice(-limit).reverse();

  return NextResponse.json(latest);
}

export async function POST(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as Partial<AutomationLog>;
  const message = payload.message?.trim();
  const level = payload.level ?? "info";

  if (!message) {
    return NextResponse.json(
      { error: "message is required" },
      { status: 400 }
    );
  }

  const record: AutomationLog = {
    id: randomUUID(),
    message,
    level: level as "info" | "success" | "error",
    accountId: payload.accountId?.trim(),
    groupId: payload.groupId?.trim(),
    sheetRow: payload.sheetRow,
    details: payload.details?.trim(),
    createdAt: new Date().toISOString(),
  };

  await appendParquetRecords("logs", [record]);
  return NextResponse.json(record, { status: 201 });
}

export async function PUT(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as Partial<AutomationLog> & { id?: string };
  const id = payload.id?.trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const current = await readParquetRecords("logs");
  const index = current.findIndex((item) => item.id === id);

  if (index < 0) {
    return NextResponse.json({ error: "Log not found" }, { status: 404 });
  }

  const updated: AutomationLog = {
    ...current[index],
    level: payload.level ?? current[index].level,
    message: payload.message ?? current[index].message,
    accountId: payload.accountId ?? current[index].accountId,
    groupId: payload.groupId ?? current[index].groupId,
    sheetRow: payload.sheetRow ?? current[index].sheetRow,
    details: payload.details ?? current[index].details,
  };

  current[index] = updated;
  await writeParquetRecords("logs", current);

  return NextResponse.json(updated);
}

export async function DELETE(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as { id?: string; olderThan?: string };
  const id = payload.id?.trim();
  const olderThan = payload.olderThan?.trim();

  if (!id && !olderThan) {
    return NextResponse.json(
      { error: "Either id or olderThan is required" },
      { status: 400 }
    );
  }

  let matcher: (record: AutomationLog) => boolean;
  if (id) {
    matcher = (record) => record.id === id;
  } else {
    const cutoffDate = new Date(olderThan!).toISOString();
    matcher = (record) => record.createdAt < cutoffDate;
  }

  const result = await deleteParquetRecords("logs", matcher);

  if (result.deletedCount === 0) {
    return NextResponse.json({ error: "No logs found matching criteria" }, { status: 404 });
  }

  return NextResponse.json({ success: true, deletedCount: result.deletedCount });
}
