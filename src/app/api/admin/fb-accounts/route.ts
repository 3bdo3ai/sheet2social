import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  appendParquetRecords,
  deleteParquetRecords,
  initializeDbStorage,
  readParquetRecords,
  writeParquetRecords,
} from "@/lib/db";
import type { FbAccount, ProxyRecord } from "@/lib/db";
import { parseBooleanCsvValue, parseCsv, validateCsvHeaders } from "@/lib/csvImport";
import { attemptFacebookAccountLogin } from "@/lib/facebookSession";

export const runtime = "nodejs";

export async function GET() {
  await initializeDbStorage();
  const records = await readParquetRecords("fbAccounts");
  return NextResponse.json(records);
}

export async function POST(request: Request) {
  await initializeDbStorage();

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const action = String(formData.get("action") ?? "").trim();

    if (action !== "bulk") {
      return NextResponse.json({ error: "Invalid multipart action" }, { status: 400 });
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "CSV file is required" }, { status: 400 });
    }

    const parsed = parseCsv(await file.text());
    const legacySchemaError = validateCsvHeaders(parsed.headers, [
      "name",
      "alias",
      "username",
      "password",
      "socks5_proxy_host",
      "socks5_proxy_port",
      "post_filter",
      "posting_method",
      "is_active",
    ]);
    const schemaError =
      legacySchemaError === null
        ? null
        : validateCsvHeaders(parsed.headers, [
            "name",
            "alias",
            "username",
            "password",
            "two_factor_secret",
            "socks5_proxy_host",
            "socks5_proxy_port",
            "socks5_proxy_username",
            "socks5_proxy_password",
            "post_filter",
            "posting_method",
            "is_active",
          ]) ?? legacySchemaError;

    if (schemaError) {
      return NextResponse.json({ error: schemaError }, { status: 400 });
    }

    const allowedPostFilters = new Set(["all", "with-comments", "without-comments"]);
    const allowedPostingMethods = new Set([
      "post-all-sequential",
      "one-post-per-account",
      "random",
      "random-no-repeat",
      "progressive",
    ]);

    const now = new Date().toISOString();
    const records: FbAccount[] = [];

    for (const row of parsed.rows) {
      const name = row.name.trim();
      const username = row.username.trim();
      const password = row.password.trim();

      if (!name || !username || !password) {
        continue;
      }

      const proxyPortRaw = Number(row.socks5_proxy_port);
      const postFilter = row.post_filter.trim() || "all";
      const postingMethod = row.posting_method.trim() || "post-all-sequential";

      if (!allowedPostFilters.has(postFilter)) {
        return NextResponse.json(
          { error: `Invalid post_filter: ${postFilter}` },
          { status: 400 }
        );
      }

      if (!allowedPostingMethods.has(postingMethod)) {
        return NextResponse.json(
          { error: `Invalid posting_method: ${postingMethod}` },
          { status: 400 }
        );
      }

      records.push({
        id: randomUUID(),
        name,
        alias: row.alias.trim() || undefined,
        username,
        password,
        twoFactorSecret: String(row.two_factor_secret ?? "").trim() || undefined,
        socks5ProxyHost: row.socks5_proxy_host.trim() || undefined,
        socks5ProxyPort: Number.isFinite(proxyPortRaw) && proxyPortRaw > 0 ? proxyPortRaw : undefined,
        socks5ProxyUsername: String(row.socks5_proxy_username ?? "").trim() || undefined,
        socks5ProxyPassword: String(row.socks5_proxy_password ?? "").trim() || undefined,
        postFilter: postFilter as FbAccount["postFilter"],
        postingMethod: postingMethod as FbAccount["postingMethod"],
        isActive: parseBooleanCsvValue(row.is_active, true),
        disabledAt: undefined,
        disabledUntil: undefined,
        disabledReason: undefined,
        disabledType: undefined,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (records.length === 0) {
      return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
    }

    await appendParquetRecords("fbAccounts", records);
    return NextResponse.json({ success: true, importedCount: records.length }, { status: 201 });
  }

  const payload = (await request.json()) as Partial<FbAccount> & { autoLogin?: boolean };
  const name = payload.name?.trim();
  const alias = payload.alias?.trim();
  const username = payload.username?.trim();
  const password = payload.password?.trim();
  const twoFactorSecret = payload.twoFactorSecret?.trim();
  const proxyId = payload.proxyId?.trim();
  const socks5ProxyHost = payload.socks5ProxyHost?.trim() || undefined;
  const rawProxyPort = Number(payload.socks5ProxyPort);
  const socks5ProxyPort = Number.isFinite(rawProxyPort) && rawProxyPort > 0 ? rawProxyPort : undefined;
  const socks5ProxyUsername = payload.socks5ProxyUsername?.trim() || undefined;
  const socks5ProxyPassword = payload.socks5ProxyPassword?.trim() || undefined;
  const autoLogin = payload.autoLogin !== false;

  const hasManualProxyHost = Boolean(socks5ProxyHost);
  const hasManualProxyPort = socks5ProxyPort !== undefined;
  const hasManualProxyAuthUser = Boolean(socks5ProxyUsername);
  const hasManualProxyAuthPassword = Boolean(socks5ProxyPassword);

  if (!name || !username || !password) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  if (hasManualProxyHost !== hasManualProxyPort) {
    return NextResponse.json(
      { error: "Manual proxy requires both host and port." },
      { status: 400 }
    );
  }

  if (hasManualProxyAuthUser !== hasManualProxyAuthPassword) {
    return NextResponse.json(
      { error: "Manual proxy authentication requires both username and password." },
      { status: 400 }
    );
  }

  if (proxyId && (hasManualProxyHost || hasManualProxyPort || hasManualProxyAuthUser || hasManualProxyAuthPassword)) {
    return NextResponse.json(
      { error: "Choose one proxy mechanism: saved proxy OR manual proxy fields." },
      { status: 400 }
    );
  }

  if (proxyId) {
    const proxies = await readParquetRecords("proxies");
    const selectedProxy = proxies.find((proxy) => proxy.id === proxyId);
    if (!selectedProxy) {
      return NextResponse.json({ error: "Proxy not found" }, { status: 404 });
    }
  }

  let resolvedProxyId = proxyId || undefined;
  if (!resolvedProxyId && socks5ProxyHost && socks5ProxyPort) {
    const nowProxy = new Date().toISOString();
    const proxyRecord: ProxyRecord = {
      id: randomUUID(),
      ipAddress: socks5ProxyHost,
      port: socks5ProxyPort,
      username: socks5ProxyUsername,
      password: socks5ProxyPassword,
      enabled: true,
      createdAt: nowProxy,
      updatedAt: nowProxy,
    };

    await appendParquetRecords("proxies", [proxyRecord]);
    resolvedProxyId = proxyRecord.id;
  }

  const now = new Date().toISOString();
  const record: FbAccount = {
    id: randomUUID(),
    name,
    alias,
    username,
    password,
    twoFactorSecret: twoFactorSecret || undefined,
    proxyId: resolvedProxyId,
    socks5ProxyHost,
    socks5ProxyPort,
    socks5ProxyUsername,
    socks5ProxyPassword,
    postFilter: "all",
    postingMethod: "post-all-sequential",
    isActive: true,
    disabledAt: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    disabledType: undefined,
    createdAt: now,
    updatedAt: now,
  };

  await appendParquetRecords("fbAccounts", [record]);

  if (!autoLogin) {
    return NextResponse.json(
      {
        ...record,
        loginAttempted: false,
      },
      { status: 201 }
    );
  }

  const loginResult = await attemptFacebookAccountLogin(record.id);
  return NextResponse.json(
    {
      ...record,
      loginAttempted: true,
      loginSucceeded: loginResult.hasSession,
      loginProxyIp: loginResult.proxyPublicIp,
      loginMessage: loginResult.message,
    },
    { status: 201 }
  );
}

export async function PUT(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as Partial<FbAccount> & { id?: string };
  const id = payload.id?.trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const current = await readParquetRecords("fbAccounts");
  const index = current.findIndex((item) => item.id === id);

  if (index < 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const hasProxyHostField = payload.socks5ProxyHost !== undefined;
  const hasProxyPortField = payload.socks5ProxyPort !== undefined;
  const hasProxyUserField = payload.socks5ProxyUsername !== undefined;
  const hasProxyPasswordField = payload.socks5ProxyPassword !== undefined;

  const incomingProxyHost = hasProxyHostField ? payload.socks5ProxyHost?.trim() || undefined : undefined;
  const incomingProxyPortNumber = hasProxyPortField ? Number(payload.socks5ProxyPort) : undefined;
  const incomingProxyPort =
    hasProxyPortField &&
    incomingProxyPortNumber !== undefined &&
    Number.isFinite(incomingProxyPortNumber) &&
    incomingProxyPortNumber > 0
      ? incomingProxyPortNumber
      : undefined;
  const incomingProxyUser = hasProxyUserField ? payload.socks5ProxyUsername?.trim() || undefined : undefined;
  const incomingProxyPassword = hasProxyPasswordField ? payload.socks5ProxyPassword?.trim() || undefined : undefined;

  const hasIncomingManualProxyHost = Boolean(incomingProxyHost);
  const hasIncomingManualProxyPort = incomingProxyPort !== undefined;
  const hasIncomingManualProxyUser = Boolean(incomingProxyUser);
  const hasIncomingManualProxyPassword = Boolean(incomingProxyPassword);

  if ((hasProxyHostField || hasProxyPortField) && hasIncomingManualProxyHost !== hasIncomingManualProxyPort) {
    return NextResponse.json(
      { error: "Manual proxy requires both host and port." },
      { status: 400 }
    );
  }

  if ((hasProxyUserField || hasProxyPasswordField) && hasIncomingManualProxyUser !== hasIncomingManualProxyPassword) {
    return NextResponse.json(
      { error: "Manual proxy authentication requires both username and password." },
      { status: 400 }
    );
  }

  if (
    payload.proxyId?.trim() &&
    (hasIncomingManualProxyHost || hasIncomingManualProxyPort || hasIncomingManualProxyUser || hasIncomingManualProxyPassword)
  ) {
    return NextResponse.json(
      { error: "Choose one proxy mechanism: saved proxy OR manual proxy fields." },
      { status: 400 }
    );
  }

  if (payload.proxyId) {
    const proxies = await readParquetRecords("proxies");
    const selectedProxy = proxies.find((proxy) => proxy.id === payload.proxyId?.trim());
    if (!selectedProxy) {
      return NextResponse.json({ error: "Proxy not found" }, { status: 404 });
    }
  }

  const updated = {
    ...current[index],
    name: payload.name?.trim() ?? current[index].name,
    postFilter: payload.postFilter ?? current[index].postFilter,
    postingMethod: payload.postingMethod ?? current[index].postingMethod,
    isActive: payload.isActive ?? current[index].isActive,
    alias: payload.alias?.trim() || undefined,
    username: payload.username?.trim() ?? current[index].username,
    password: payload.password?.trim() ?? current[index].password,
    twoFactorSecret: payload.twoFactorSecret?.trim() || undefined,
    proxyId: payload.proxyId?.trim() || undefined,
    socks5ProxyHost: payload.socks5ProxyHost !== undefined ? payload.socks5ProxyHost.trim() || undefined : current[index].socks5ProxyHost,
    socks5ProxyPort: payload.socks5ProxyPort !== undefined
      ? (Number.isFinite(Number(payload.socks5ProxyPort)) && Number(payload.socks5ProxyPort) > 0 ? Number(payload.socks5ProxyPort) : undefined)
      : current[index].socks5ProxyPort,
    socks5ProxyUsername: payload.socks5ProxyUsername !== undefined ? payload.socks5ProxyUsername.trim() || undefined : current[index].socks5ProxyUsername,
    socks5ProxyPassword: payload.socks5ProxyPassword !== undefined ? payload.socks5ProxyPassword.trim() || undefined : current[index].socks5ProxyPassword,
    disabledAt:
      payload.isActive === true
        ? undefined
        : payload.isActive === false && current[index].isActive === true
          ? new Date().toISOString()
          : current[index].disabledAt,
    disabledUntil: payload.isActive === true ? undefined : current[index].disabledUntil,
    disabledReason:
      payload.isActive === true
        ? undefined
        : payload.isActive === false && current[index].isActive === true
          ? "Disabled from dashboard"
          : current[index].disabledReason,
    disabledType:
      payload.isActive === true
        ? undefined
        : payload.isActive === false && current[index].isActive === true
          ? "manual"
          : current[index].disabledType,
    updatedAt: new Date().toISOString(),
  };

  current[index] = updated;
  await writeParquetRecords("fbAccounts", current);

  return NextResponse.json(updated);
}

export async function DELETE(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as { id?: string };
  const id = payload.id?.trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const result = await deleteParquetRecords("fbAccounts", (record) => record.id === id);

  if (result.deletedCount === 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, deletedCount: result.deletedCount });
}
