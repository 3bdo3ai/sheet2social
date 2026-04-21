import { NextResponse } from "next/server";

import {
  LicenseAuthError,
  createSessionForLicenseKey,
  setLicenseSessionCookie,
} from "@/lib/license/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = (await request.json()) as {
    keyString?: string;
    deviceId?: string;
    forceReplaceDevice?: boolean;
  };

  const keyString = payload.keyString?.trim() ?? "";
  const deviceId = payload.deviceId?.trim() ?? "";
  const forceReplaceDevice = payload.forceReplaceDevice === true;

  try {
    const { token, session } = await createSessionForLicenseKey(keyString, deviceId, {
      forceReplaceDevice,
    });
    const response = NextResponse.json({ session });
    setLicenseSessionCookie(response, token, request);
    return response;
  } catch (error) {
    if (error instanceof LicenseAuthError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }

    const message = error instanceof Error ? error.message : "Unable to authenticate license key.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
