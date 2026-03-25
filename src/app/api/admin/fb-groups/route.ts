import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import {
  appendParquetRecords,
  deleteParquetRecords,
  initializeDbStorage,
  readParquetRecords,
  writeParquetRecords,
} from "@/lib/db";
import type { FbGroup } from "@/lib/db";
import { ensureCsvFile } from "@/lib/csvPosts";

export const runtime = "nodejs";

const CSV_DIRECTORY = path.join(process.cwd(), "data", "csvs");

export async function GET() {
  await initializeDbStorage();
  const records = await readParquetRecords("fbGroups");
  return NextResponse.json(records);
}

export async function POST(request: Request) {
  await initializeDbStorage();

  const formData = await request.formData();
  const groupId = String(formData.get("groupId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const fbAccountId = String(formData.get("fbAccountId") ?? "").trim();
  const file = formData.get("csv");

  if (!groupId) {
    return NextResponse.json(
      { error: "Group ID is required" },
      { status: 400 }
    );
  }

  if (file instanceof File && !file.name.toLowerCase().endsWith(".csv")) {
    return NextResponse.json({ error: "Only .csv files are allowed" }, { status: 400 });
  }

  await fs.mkdir(CSV_DIRECTORY, { recursive: true });

  const csvFileName = `${groupId}.csv`;
  const absoluteCsvPath = path.join(CSV_DIRECTORY, csvFileName);
  if (file instanceof File) {
    const bytes = await file.arrayBuffer();
    await fs.writeFile(absoluteCsvPath, Buffer.from(bytes));
  } else {
    await ensureCsvFile(absoluteCsvPath);
  }

  const relativeCsvPath = path.join("data", "csvs", csvFileName).replace(/\\/g, "/");
  const now = new Date().toISOString();
  const record: FbGroup = {
    id: randomUUID(),
    groupId,
    name: name || undefined,
    csvPath: relativeCsvPath,
    fbAccountId: fbAccountId || undefined,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  await appendParquetRecords("fbGroups", [record]);
  return NextResponse.json(record, { status: 201 });
}

export async function PUT(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as Partial<FbGroup> & { id?: string };
  const id = payload.id?.trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const current = await readParquetRecords("fbGroups");
  const index = current.findIndex((item) => item.id === id);
  if (index < 0) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const updated: FbGroup = {
    ...current[index],
    name: payload.name ?? current[index].name,
    fbAccountId: payload.fbAccountId ?? current[index].fbAccountId,
    isActive: payload.isActive ?? current[index].isActive,
    updatedAt: new Date().toISOString(),
  };

  current[index] = updated;
  await writeParquetRecords("fbGroups", current);
  return NextResponse.json(updated);
}

export async function DELETE(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as { id?: string };
  const id = payload.id?.trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const current = await readParquetRecords("fbGroups");
  const groupToDelete = current.find((item) => item.id === id);

  if (!groupToDelete) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  // Delete associated CSV file if it exists
  try {
    const csvPath = path.join(process.cwd(), groupToDelete.csvPath);
    await fs.unlink(csvPath);
  } catch {
    // CSV file might not exist, which is fine
  }

  const result = await deleteParquetRecords("fbGroups", (record) => record.id === id);

  return NextResponse.json({ success: true, deletedCount: result.deletedCount });
}
