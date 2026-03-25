import { NextResponse } from "next/server";

import { readCsvPosts } from "@/lib/csvPosts";
import { initializeDbStorage, readAutomationState, readParquetRecords } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  await initializeDbStorage();

  const [accounts, groups, automation] = await Promise.all([
    readParquetRecords("fbAccounts"),
    readParquetRecords("fbGroups"),
    readAutomationState(),
  ]);

  const postRows = await Promise.all(groups.map((group) => readCsvPosts(group.csvPath)));
  const totalPosts = postRows.reduce((acc, items) => acc + items.length, 0);

  return NextResponse.json({
    totalPosts,
    totalGroups: groups.length,
    totalAccounts: accounts.length,
    status: automation.state,
  });
}
