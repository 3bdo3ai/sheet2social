import { NextResponse } from "next/server";

import { requireAdminLicenseSession } from "@/lib/license/auth";
import { createLicenseRecord, listLicenseKeys } from "@/lib/license/admin";
import type { LicenseStatus } from "@/lib/license/types";

export const runtime = "nodejs";

function toStatus(value: string | null): LicenseStatus | "all" {
  if (!value) {
    return "all";
  }

  if (value === "all" || value === "active" || value === "paused" || value === "expired" || value === "revoked") {
    return value;
  }

  return "all";
}

export async function GET(request: Request) {
  await requireAdminLicenseSession();

  const { searchParams } = new URL(request.url);
  const status = toStatus(searchParams.get("status"));
  const search = searchParams.get("search")?.trim() ?? "";
  const sortBy = searchParams.get("sortBy");
  const sortOrder = searchParams.get("sortOrder") === "asc" ? "asc" : "desc";

  try {
    const rows = await listLicenseKeys({
      status,
      search,
      sortBy:
        sortBy === "valid_until" || sortBy === "status" || sortBy === "key_string" || sortBy === "created_at"
          ? sortBy
          : "created_at",
      sortOrder,
    });

    return NextResponse.json(rows);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load keys.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  await requireAdminLicenseSession();

  const payload = (await request.json()) as {
    durationDays?: number;
    validUntil?: string;
    userName?: string;
    userPhone?: string;
    userEmail?: string;
    adminNotes?: string;
  };

  try {
    const created = await createLicenseRecord(payload);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create key.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
