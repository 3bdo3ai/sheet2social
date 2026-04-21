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
import { parseBooleanCsvValue, parseCsv, validateCsvHeaders } from "@/lib/csvImport";
import { ensureCsvFile } from "@/lib/csvPosts";
import { getRuntimeCsvDir } from "@/lib/runtimePaths";

export const runtime = "nodejs";

const CSV_DIRECTORY = getRuntimeCsvDir();

function normalizeAssignedAccountIds(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
  }

  const raw = String(input ?? "").trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildAssignedAccountStorageValue(accountIds: string[]): string | undefined {
  const unique = Array.from(new Set(accountIds.filter(Boolean)));
  return unique.length > 0 ? unique.join(",") : undefined;
}

function resolveGroupCsvAbsolutePath(csvPathValue: string): string {
  // Keep deletes scoped to the known CSV directory to avoid wide output tracing.
  return path.join(CSV_DIRECTORY, path.basename(csvPathValue));
}

export async function GET() {
  await initializeDbStorage();
  const records = await readParquetRecords("fbGroups");
  const normalized = records.map((record) => {
    const accountIds = normalizeAssignedAccountIds((record as FbGroup & { fbAccountIds?: unknown }).fbAccountIds ?? record.fbAccountId);
    return {
      ...record,
      fbAccountId: accountIds[0],
      fbAccountIds: accountIds,
    };
  });

  return NextResponse.json(normalized);
}

export async function POST(request: Request) {
  await initializeDbStorage();

  const formData = await request.formData();
  const action = String(formData.get("action") ?? "single").trim();

  if (action === "bulk") {
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "CSV file is required" }, { status: 400 });
    }

    const parsed = parseCsv(await file.text());
    const schemaError = validateCsvHeaders(parsed.headers, [
      "group_id",
      "name",
      "fb_account_id",
      "is_active",
    ]);

    if (schemaError) {
      return NextResponse.json({ error: schemaError }, { status: 400 });
    }

    const existingGroups = await readParquetRecords("fbGroups");
    const existingAccounts = await readParquetRecords("fbAccounts");
    const existingGroupIds = new Set(existingGroups.map((item) => item.groupId));
    const existingAccountIds = new Set(existingAccounts.map((item) => item.id));
    const now = new Date().toISOString();
    const toInsert: FbGroup[] = [];

    for (const row of parsed.rows) {
      const groupId = row.group_id.trim();
      if (!groupId || existingGroupIds.has(groupId)) {
        continue;
      }

      const parsedIds = normalizeAssignedAccountIds(row.fb_account_id);
      const invalidAccountId = parsedIds.find((accountId) => !existingAccountIds.has(accountId));
      if (invalidAccountId) {
        return NextResponse.json(
          { error: `Invalid fb_account_id: ${invalidAccountId}` },
          { status: 400 }
        );
      }

      const csvFileName = `${groupId}.csv`;
      const absoluteCsvPath = path.join(CSV_DIRECTORY, csvFileName);
      await ensureCsvFile(absoluteCsvPath);

      toInsert.push({
        id: randomUUID(),
        groupId,
        name: row.name.trim() || undefined,
        csvPath: path.join("data", "csvs", csvFileName).replace(/\\/g, "/"),
        fbAccountId: buildAssignedAccountStorageValue(parsedIds),
        isActive: parseBooleanCsvValue(row.is_active, true),
        createdAt: now,
        updatedAt: now,
      });

      existingGroupIds.add(groupId);
    }

    if (toInsert.length === 0) {
      return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
    }

    await appendParquetRecords("fbGroups", toInsert);
    return NextResponse.json({ success: true, importedCount: toInsert.length }, { status: 201 });
  }

  const groupId = String(formData.get("groupId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const fbAccountIds = normalizeAssignedAccountIds(formData.getAll("fbAccountIds"));
  const legacyAccountId = String(formData.get("fbAccountId") ?? "").trim();
  const assignedAccountIds = fbAccountIds.length > 0 ? fbAccountIds : normalizeAssignedAccountIds(legacyAccountId);
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

  const existingAccounts = await readParquetRecords("fbAccounts");
  const existingAccountIds = new Set(existingAccounts.map((item) => item.id));
  const invalidAccountId = assignedAccountIds.find((accountId) => !existingAccountIds.has(accountId));
  if (invalidAccountId) {
    return NextResponse.json({ error: `Invalid account assignment: ${invalidAccountId}` }, { status: 400 });
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
    fbAccountId: buildAssignedAccountStorageValue(assignedAccountIds),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  await appendParquetRecords("fbGroups", [record]);
  return NextResponse.json(record, { status: 201 });
}

export async function PUT(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as Partial<FbGroup> & {
    id?: string;
    fbAccountIds?: string[];
  };
  const id = payload.id?.trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const current = await readParquetRecords("fbGroups");
  const index = current.findIndex((item) => item.id === id);
  if (index < 0) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const existingAccounts = await readParquetRecords("fbAccounts");
  const existingAccountIds = new Set(existingAccounts.map((item) => item.id));

  const assignedAccountIds =
    payload.fbAccountIds !== undefined
      ? normalizeAssignedAccountIds(payload.fbAccountIds)
      : payload.fbAccountId !== undefined
        ? normalizeAssignedAccountIds(payload.fbAccountId)
        : normalizeAssignedAccountIds(current[index].fbAccountId);

  const invalidAccountId = assignedAccountIds.find((accountId) => !existingAccountIds.has(accountId));
  if (invalidAccountId) {
    return NextResponse.json({ error: `Invalid account assignment: ${invalidAccountId}` }, { status: 400 });
  }

  const updated: FbGroup = {
    ...current[index],
    name: payload.name ?? current[index].name,
    fbAccountId: buildAssignedAccountStorageValue(assignedAccountIds),
    isActive: payload.isActive ?? current[index].isActive,
    updatedAt: new Date().toISOString(),
  };

  current[index] = updated;
  await writeParquetRecords("fbGroups", current);
  return NextResponse.json({
    ...updated,
    fbAccountId: assignedAccountIds[0],
    fbAccountIds: assignedAccountIds,
  });
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
    const csvPath = resolveGroupCsvAbsolutePath(groupToDelete.csvPath);
    await fs.unlink(csvPath);
  } catch {
    // CSV file might not exist, which is fine
  }

  const result = await deleteParquetRecords("fbGroups", (record) => record.id === id);

  return NextResponse.json({ success: true, deletedCount: result.deletedCount });
}
