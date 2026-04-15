import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  LICENSE_ADMIN_PATH,
  LICENSE_LOGIN_PATH,
  LICENSE_SESSION_COOKIE,
  LICENSE_USER_PATH,
} from "@/lib/license/constants";

const PROTECTED_PREFIXES = [
  LICENSE_USER_PATH,
  LICENSE_ADMIN_PATH,
  "/posts",
  "/comment-test",
  "/groups",
  "/accounts",
  "/automation",
  "/settings",
  "/proxies",
  "/fb-accounts",
  "/fb-groups",
];

function shouldProtect(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function redirectToLogin(request: NextRequest, reason: string): NextResponse {
  const target = new URL(LICENSE_LOGIN_PATH, request.url);
  target.searchParams.set("reason", reason);

  const response = NextResponse.redirect(target);
  response.cookies.delete(LICENSE_SESSION_COOKIE);
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!shouldProtect(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(LICENSE_SESSION_COOKIE)?.value;
  if (!token) {
    return redirectToLogin(request, "missing_session");
  }

  const verifyUrl = new URL("/api/license/session", request.url);
  const verificationResponse = await fetch(verifyUrl, {
    method: "GET",
    headers: {
      cookie: request.headers.get("cookie") ?? "",
      "x-license-middleware": "1",
    },
    cache: "no-store",
  });

  if (!verificationResponse.ok) {
    const errorPayload = (await verificationResponse.json().catch(() => null)) as
      | { reason?: string }
      | null;

    const reason = typeof errorPayload?.reason === "string" ? errorPayload.reason : "invalid_session";
    return redirectToLogin(request, reason);
  }

  if (pathname.startsWith(LICENSE_ADMIN_PATH)) {
    const payload = (await verificationResponse.json().catch(() => null)) as
      | { session?: { isAdmin?: boolean } }
      | null;

    if (!payload?.session?.isAdmin) {
      return NextResponse.redirect(new URL(LICENSE_USER_PATH, request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/client/:path*",
    "/admin/licenses/:path*",
    "/dashboard/:path*",
    "/posts/:path*",
    "/comment-test/:path*",
    "/groups/:path*",
    "/accounts/:path*",
    "/automation/:path*",
    "/settings/:path*",
    "/proxies/:path*",
    "/fb-accounts/:path*",
    "/fb-groups/:path*",
  ],
};
