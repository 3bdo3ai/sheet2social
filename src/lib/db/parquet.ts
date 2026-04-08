import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import parquet from "parquetjs-lite";

import type { EntityMap, EntityName } from "@/lib/db/entities";
import { entitySchemas } from "@/lib/db/schemas";

const STORAGE_DIR = path.join(process.cwd(), "storage");
const PARQUET_READ_RETRY_COUNT = 3;
const PARQUET_READ_RETRY_DELAY_MS = 35;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTempParquetPath(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

function isTransientFileWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST";
}

async function replaceFileWithRetry(tempFilePath: string, filePath: string): Promise<void> {
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fs.rename(tempFilePath, filePath);
      return;
    } catch (error) {
      if (!isTransientFileWriteError(error) || attempt === maxAttempts - 1) {
        throw error;
      }

      // On Windows, rename can fail while destination exists/is temporarily locked.
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      await sleep(PARQUET_READ_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

function isRetryableParquetReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ERR_OUT_OF_RANGE") {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("out of range") ||
    message.includes("unexpected end") ||
    message.includes("invalid parquet")
  );
}

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
  const tempFilePath = buildTempParquetPath(filePath);
  const schema = new parquet.ParquetSchema(entitySchemas[entityName]);
  let writer: Awaited<ReturnType<typeof parquet.ParquetWriter.openFile>> | undefined;

  try {
    writer = await parquet.ParquetWriter.openFile(schema, tempFilePath);

    for (const record of records) {
      await writer.appendRow(record);
    }

    await writer.close();
    writer = undefined;

    await replaceFileWithRetry(tempFilePath, filePath);
  } catch (error) {
    if (writer) {
      await writer.close().catch(() => undefined);
    }

    await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
    throw error;
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

  for (let attempt = 0; attempt <= PARQUET_READ_RETRY_COUNT; attempt += 1) {
    let reader: Awaited<ReturnType<typeof parquet.ParquetReader.openFile>> | undefined;

    try {
      reader = await parquet.ParquetReader.openFile(filePath);

      const cursor = reader.getCursor();
      const rows: Array<EntityMap[K]> = [];

      let row = await cursor.next();
      while (row) {
        rows.push(row as EntityMap[K]);
        row = await cursor.next();
      }

      return rows;
    } catch (error) {
      const retryable = isRetryableParquetReadError(error);
      if (!retryable || attempt === PARQUET_READ_RETRY_COUNT) {
        throw error;
      }

      await sleep(PARQUET_READ_RETRY_DELAY_MS * (attempt + 1));
    } finally {
      if (reader) {
        await reader.close().catch(() => undefined);
      }
    }
  }

  return [];
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
