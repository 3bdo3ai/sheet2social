import { NextResponse } from "next/server";

import {
  attemptFacebookAccountLogin,
  cancelManualFacebookAccountLogin,
  classifyStoredSessionCookies,
  finalizeManualFacebookAccountLogin,
  getStoredSessionCookies,
  startManualFacebookAccountLogin,
} from "@/lib/facebookSession";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("accountId")?.trim();
  const includeCookies = searchParams.get("includeCookies") === "true";

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const cookies = await getStoredSessionCookies(accountId);
  const sessionStatus = classifyStoredSessionCookies(cookies);

  return NextResponse.json({
    accountId,
    hasSession: sessionStatus.hasSession,
    reason: sessionStatus.reason,
    cookieCount: sessionStatus.cookieCount,
    cookies: includeCookies && cookies.length > 0 ? cookies : undefined,
  });
}

export async function POST(request: Request) {
  const payload = (await request.json()) as {
    action?: "auto-login" | "manual-start" | "manual-confirm" | "manual-cancel";
    accountId?: string;
    manualLoginId?: string;
  };

  const action = payload.action ?? "auto-login";
  const accountId = payload.accountId?.trim();
  const manualLoginId = payload.manualLoginId?.trim();

  if (action === "manual-start") {
    if (!accountId) {
      return NextResponse.json({ error: "accountId is required" }, { status: 400 });
    }

    try {
      const result = await startManualFacebookAccountLogin(accountId);
      return NextResponse.json({
        action,
        accountId: result.accountId,
        manualLoginId: result.manualLoginId,
        hasSession: false,
        proxyPublicIp: result.proxyPublicIp,
        message: result.message,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start manual login";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  if (action === "manual-confirm") {
    if (!manualLoginId) {
      return NextResponse.json({ error: "manualLoginId is required" }, { status: 400 });
    }

    const result = await finalizeManualFacebookAccountLogin(manualLoginId);
    return NextResponse.json({
      action,
      accountId: result.accountId,
      hasSession: result.hasSession,
      proxyPublicIp: result.proxyPublicIp,
      message: result.message,
    });
  }

  if (action === "manual-cancel") {
    if (!manualLoginId) {
      return NextResponse.json({ error: "manualLoginId is required" }, { status: 400 });
    }

    const result = await cancelManualFacebookAccountLogin(manualLoginId);
    return NextResponse.json({
      action,
      accountId: result.accountId,
      hasSession: false,
      message: result.message,
    });
  }

  if (action !== "auto-login") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const result = await attemptFacebookAccountLogin(accountId);

  return NextResponse.json({
    accountId,
    hasSession: result.hasSession,
    proxyPublicIp: result.proxyPublicIp,
    message: result.message,
  });
}
