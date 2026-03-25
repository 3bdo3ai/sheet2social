import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import parquet from "parquetjs-lite";

import type { EntityMap, EntityName } from "@/lib/db/entities";
import { entitySchemas } from "@/lib/db/schemas";

const STORAGE_DIR = path.join(process.cwd(), "storage");

export interface UpdateParquetResult<K extends EntityName> {
  updatedCount: number;
  records: Array<EntityMap[K]>;
}

async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

function getEntityFilePath(entityName: EntityName): string {
  return path.join(STORAGE_DIR, `${entityName}.parquet`);
}

export async function createParquetFile<K extends EntityName>(
  entityName: K,
  initialRecords: Array<EntityMap[K]> = []
): Promise<void> {
  const filePath = getEntityFilePath(entityName);

  try {
    await fs.access(filePath);
    return;
  } catch {
    await writeParquetRecords(entityName, initialRecords);
  }
}

export async function writeParquetRecords<K extends EntityName>(
  entityName: K,
  records: Array<EntityMap[K]>
): Promise<void> {
  await ensureStorageDir();

  const filePath = getEntityFilePath(entityName);
  const schema = new parquet.ParquetSchema(entitySchemas[entityName]);
  const writer = await parquet.ParquetWriter.openFile(schema, filePath);

  try {
    for (const record of records) {
      await writer.appendRow(record);
    }
  } finally {
    await writer.close();
  }
}

export async function readParquetRecords<K extends EntityName>(
  entityName: K
): Promise<Array<EntityMap[K]>> {
  await ensureStorageDir();

  const filePath = getEntityFilePath(entityName);

  try {
    await fs.access(filePath);
  } catch {
    return [];
  }

  const reader = await parquet.ParquetReader.openFile(filePath);

  try {
    const cursor = reader.getCursor();
    const rows: Array<EntityMap[K]> = [];

    let row = await cursor.next();
    while (row) {
      rows.push(row as EntityMap[K]);
      row = await cursor.next();
    }

    return rows;
  } finally {
    await reader.close();
  }
}

export async function appendParquetRecords<K extends EntityName>(
  entityName: K,
  records: Array<EntityMap[K]>
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  const currentRecords = await readParquetRecords(entityName);
  await writeParquetRecords(entityName, [...currentRecords, ...records]);
}

export async function updateParquetRecords<K extends EntityName>(
  entityName: K,
  matcher: (record: EntityMap[K], index: number) => boolean,
  updater: (record: EntityMap[K], index: number) => EntityMap[K]
): Promise<UpdateParquetResult<K>> {
  const currentRecords = await readParquetRecords(entityName);

  let updatedCount = 0;
  const updatedRecords = currentRecords.map((record, index) => {
    if (!matcher(record, index)) {
      return record;
    }

    updatedCount += 1;
    return updater(record, index);
  });

  if (updatedCount > 0) {
    await writeParquetRecords(entityName, updatedRecords);
  }

  return {
    updatedCount,
    records: updatedRecords,
  };
}

export async function deleteParquetRecords<K extends EntityName>(
  entityName: K,
  matcher: (record: EntityMap[K], index: number) => boolean
): Promise<{ deletedCount: number }> {
  const currentRecords = await readParquetRecords(entityName);

  let deletedCount = 0;
  const filteredRecords = currentRecords.filter((record, index) => {
    if (matcher(record, index)) {
      deletedCount += 1;
      return false;
    }
    return true;
  });

  if (deletedCount > 0) {
    await writeParquetRecords(entityName, filteredRecords);
  }

  return { deletedCount };
}

export function getParquetPath(entityName: EntityName): string {
  return getEntityFilePath(entityName);
}
