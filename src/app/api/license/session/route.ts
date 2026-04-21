import { NextResponse } from "next/server";

import {
  clearLicenseSessionCookie,
  validateSessionFromCookies,
} from "@/lib/license/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const validation = await validateSessionFromCookies();

  if (!validation.ok) {
    const response = NextResponse.json({ error: validation.message, reason: validation.reason }, { status: validation.statusCode });

    if (validation.reason !== "missing_session") {
      clearLicenseSessionCookie(response, request);
    }

    return response;
  }

  return NextResponse.json({ session: validation.session });
}
