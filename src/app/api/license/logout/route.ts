import { NextResponse } from "next/server";

import {
  clearLicenseSessionCookie,
  releaseCurrentDeviceBinding,
} from "@/lib/license/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as { releaseDevice?: boolean };

  if (payload.releaseDevice ?? true) {
    await releaseCurrentDeviceBinding();
  }

  const response = NextResponse.json({ success: true });
  clearLicenseSessionCookie(response, request);
  return response;
}
