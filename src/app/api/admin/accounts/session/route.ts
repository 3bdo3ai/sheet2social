import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { appendParquetRecords, readParquetRecords } from "@/lib/db";
import type { FbAccount } from "@/lib/db";

import {
  attemptFacebookAccountLogin,
  cancelManualFacebookAccountLogin,
  classifyStoredSessionCookies,
  finalizeManualFacebookAccountLogin,
  getStoredSessionCookies,
  saveImportedSessionCookies,
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
    action?: "auto-login" | "manual-start" | "manual-confirm" | "manual-cancel" | "cookie-login";
    accountId?: string;
    manualLoginId?: string;
    name?: string;
    alias?: string;
    proxyId?: string;
    cookies?: unknown;
  };

  const action = payload.action ?? "auto-login";
  const accountId = payload.accountId?.trim();
  const manualLoginId = payload.manualLoginId?.trim();

  if (action === "cookie-login") {
    const name = payload.name?.trim();
    const alias = payload.alias?.trim() || undefined;
    const proxyId = payload.proxyId?.trim() || undefined;

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    let importedCookies: unknown[] = [];
    if (Array.isArray(payload.cookies)) {
      importedCookies = payload.cookies;
    } else if (
      payload.cookies &&
      typeof payload.cookies === "object" &&
      "cookies" in (payload.cookies as Record<string, unknown>) &&
      Array.isArray((payload.cookies as Record<string, unknown>).cookies)
    ) {
      importedCookies = (payload.cookies as Record<string, unknown>).cookies as unknown[];
    }

    if (importedCookies.length === 0) {
      return NextResponse.json({ error: "cookies array is required" }, { status: 400 });
    }

    const normalizedCookies = importedCookies
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const value = item as Record<string, unknown>;
        const expiryRaw = value.expiry;
        const expiry =
          typeof expiryRaw === "number"
            ? expiryRaw
            : typeof expiryRaw === "string" && expiryRaw.trim()
              ? Number(expiryRaw)
              : undefined;

        return {
          name: typeof value.name === "string" ? value.name.trim() : "",
          value: typeof value.value === "string" ? value.value : "",
          domain: typeof value.domain === "string" ? value.domain : undefined,
          path: typeof value.path === "string" ? value.path : undefined,
          secure: typeof value.secure === "boolean" ? value.secure : undefined,
          httpOnly: typeof value.httpOnly === "boolean" ? value.httpOnly : undefined,
          expiry: Number.isFinite(expiry) ? expiry : undefined,
          sameSite:
            value.sameSite === "Lax" || value.sameSite === "Strict" || value.sameSite === "None"
              ? value.sameSite
              : undefined,
        };
      })
      .filter((cookie) => cookie.name && typeof cookie.value === "string");

    if (normalizedCookies.length === 0) {
      return NextResponse.json(
        { error: "No valid cookies found. Each cookie needs name and value." },
        { status: 400 }
      );
    }

    const cookieStatus = classifyStoredSessionCookies(normalizedCookies);
    if (!cookieStatus.hasSession) {
      return NextResponse.json(
        {
          error:
            "Imported cookies are missing required Facebook auth cookies (c_user and xs). Export cookies from a logged-in Facebook session and try again.",
        },
        { status: 400 }
      );
    }

    if (proxyId) {
      const proxies = await readParquetRecords("proxies");
      const selectedProxy = proxies.find((proxy) => proxy.id === proxyId && proxy.enabled !== false);
      if (!selectedProxy) {
        return NextResponse.json({ error: "Selected proxy was not found" }, { status: 404 });
      }
    }

    const now = new Date().toISOString();
    const newAccountId = randomUUID();
    const record: FbAccount = {
      id: newAccountId,
      name,
      alias,
      username: `cookie-login-${newAccountId.slice(0, 8)}`,
      password: `cookie-auth-${randomUUID().slice(0, 12)}`,
      proxyId,
      postFilter: "all",
      postingMethod: "post-all-sequential",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    await appendParquetRecords("fbAccounts", [record]);
    const savedStatus = await saveImportedSessionCookies(newAccountId, normalizedCookies);

    return NextResponse.json({
      action,
      accountId: newAccountId,
      hasSession: savedStatus.hasSession,
      cookieCount: savedStatus.cookieCount,
      message: "Cookies imported successfully. The account is ready for automation.",
    });
  }

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

      if (message.includes("requires a graphical desktop session")) {
        return NextResponse.json(
          {
            error: message,
            code: "manual_login_headless",
          },
          { status: 409 }
        );
      }

      if (message.startsWith("Unable to start browser session:")) {
        return NextResponse.json(
          {
            error: message,
            code: "browser_startup_failed",
          },
          { status: 502 }
        );
      }

      return NextResponse.json({ error: message, code: "manual_login_start_failed" }, { status: 400 });
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
