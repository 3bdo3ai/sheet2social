import { NextResponse } from "next/server";

import {
  clearLicenseSessionCookie,
  markCurrentSessionExpiredIfPastDue,
} from "@/lib/license/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  await markCurrentSessionExpiredIfPastDue();

  const response = NextResponse.json({ success: true });
  clearLicenseSessionCookie(response, request);
  return response;
}
