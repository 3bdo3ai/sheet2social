import { NextResponse } from "next/server";

import { requireAdminLicenseSession } from "@/lib/license/auth";
import { getLicenseSummary } from "@/lib/license/admin";

export const runtime = "nodejs";

export async function GET() {
  await requireAdminLicenseSession();

  try {
    const summary = await getLicenseSummary();
    return NextResponse.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load summary.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
