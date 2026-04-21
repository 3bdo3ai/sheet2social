import "server-only";

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import csvParser from "csv-parser";
import { createObjectCsvWriter } from "csv-writer";
import { getRuntimeCsvDir } from "@/lib/runtimePaths";

export interface CsvPostRecord {
  post_text: string;
  image_url: string;
  comment_link: string;
  status: string;
}

export interface CsvPostWithMeta extends CsvPostRecord {
  rowIndex: number;
}

const CSV_HEADERS: Array<keyof CsvPostRecord> = [
  "post_text",
  "image_url",
  "comment_link",
  "status",
];

const CSV_BASE_DIR = getRuntimeCsvDir();

function resolveCsvPath(csvFilePath: string): string {
  const normalized = csvFilePath.replace(/\\/g, "/").trim();
  const fileName = path.basename(normalized);

  if (!fileName || fileName === "." || fileName === "/") {
    throw new Error("Invalid CSV file path.");
  }

  // Keep file operations scoped to the managed csv directory.
  return path.join(CSV_BASE_DIR, fileName);
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase();
}

function isCompletedStatus(value: string): boolean {
  const normalized = normalizeStatus(value);
  return normalized === "posted" || normalized === "done" || normalized === "completed" || normalized === "success";
}

export async function ensureCsvFile(csvFilePath: string): Promise<string> {
  const resolvedPath = resolveCsvPath(csvFilePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  try {
    await fs.access(resolvedPath);
  } catch {
    const writer = createObjectCsvWriter({
      path: resolvedPath,
      header: CSV_HEADERS.map((id) => ({ id, title: id })),
    });
    await writer.writeRecords([]);
  }

  return resolvedPath;
}

export async function readCsvPosts(csvFilePath: string): Promise<CsvPostWithMeta[]> {
  const resolvedPath = await ensureCsvFile(csvFilePath);

  return new Promise((resolve, reject) => {
    const rows: CsvPostWithMeta[] = [];

    createReadStream(resolvedPath)
      .pipe(csvParser())
      .on("data", (raw) => {
        rows.push({
          rowIndex: rows.length,
          post_text: String(raw.post_text ?? ""),
          image_url: String(raw.image_url ?? ""),
          comment_link: String(raw.comment_link ?? ""),
          status: String(raw.status ?? ""),
        });
      })
      .on("end", () => resolve(rows))
      .on("error", (error) => reject(error));
  });
}

export async function appendCsvPost(
  csvFilePath: string,
  record: CsvPostRecord
): Promise<void> {
  const resolvedPath = await ensureCsvFile(csvFilePath);
  const existing = await readCsvPosts(resolvedPath);

  const writer = createObjectCsvWriter({
    path: resolvedPath,
    header: CSV_HEADERS.map((id) => ({ id, title: id })),
  });

  await writer.writeRecords([
    ...existing.map((item) => ({
      post_text: item.post_text,
      image_url: item.image_url,
      comment_link: item.comment_link,
      status: item.status,
    })),
    record,
  ]);
}

export async function writeCsvPosts(
  csvFilePath: string,
  records: CsvPostRecord[]
): Promise<void> {
  const resolvedPath = await ensureCsvFile(csvFilePath);
  const writer = createObjectCsvWriter({
    path: resolvedPath,
    header: CSV_HEADERS.map((id) => ({ id, title: id })),
  });

  await writer.writeRecords(records);
}

export async function updateCsvPostByIndex(
  csvFilePath: string,
  rowIndex: number,
  patch: Partial<CsvPostRecord>
): Promise<boolean> {
  const resolvedPath = await ensureCsvFile(csvFilePath);
  const existing = await readCsvPosts(resolvedPath);

  if (rowIndex < 0 || rowIndex >= existing.length) {
    return false;
  }

  existing[rowIndex] = {
    ...existing[rowIndex],
    ...patch,
  };

  await writeCsvPosts(
    resolvedPath,
    existing.map((item) => ({
      post_text: item.post_text,
      image_url: item.image_url,
      comment_link: item.comment_link,
      status: item.status,
    }))
  );

  return true;
}

export async function deleteCsvPostByIndex(
  csvFilePath: string,
  rowIndex: number
): Promise<boolean> {
  const resolvedPath = await ensureCsvFile(csvFilePath);
  const existing = await readCsvPosts(resolvedPath);

  if (rowIndex < 0 || rowIndex >= existing.length) {
    return false;
  }

  const filtered = existing.filter((item) => item.rowIndex !== rowIndex);
  await writeCsvPosts(
    resolvedPath,
    filtered.map((item) => ({
      post_text: item.post_text,
      image_url: item.image_url,
      comment_link: item.comment_link,
      status: item.status,
    }))
  );

  return true;
}

export function isCsvPostCompleted(status: string): boolean {
  return isCompletedStatus(status);
}
