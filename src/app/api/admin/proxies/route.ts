import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  appendParquetRecords,
  deleteParquetRecords,
  initializeDbStorage,
  readAutomationState,
  readParquetRecords,
  writeAutomationSettings,
  writeParquetRecords,
} from "@/lib/db";
import type { ProxyRecord } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  await initializeDbStorage();

  const proxies = await readParquetRecords("proxies");
  const state = await readAutomationState();

  return NextResponse.json({
    proxyRotationEnabled: state.settings.proxyRotationEnabled,
    items: proxies,
  });
}

export async function POST(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as Partial<ProxyRecord>;
  const ipAddress = payload.ipAddress?.trim();
  const port = Number(payload.port);

  if (!ipAddress || !Number.isFinite(port) || port <= 0) {
    return NextResponse.json(
      { error: "Valid ipAddress and port are required" },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const record: ProxyRecord = {
    id: randomUUID(),
    ipAddress,
    port,
    username: payload.username?.trim() || undefined,
    password: payload.password?.trim() || undefined,
    enabled: payload.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };

  await appendParquetRecords("proxies", [record]);
  return NextResponse.json(record, { status: 201 });
}

export async function PUT(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as {
    proxyRotationEnabled?: boolean;
    items?: ProxyRecord[];
  };

  if (typeof payload.proxyRotationEnabled === "boolean") {
    await writeAutomationSettings({
      proxyRotationEnabled: payload.proxyRotationEnabled,
    });
  }

  if (Array.isArray(payload.items)) {
    await writeParquetRecords("proxies", payload.items);
  }

  const proxies = await readParquetRecords("proxies");
  const state = await readAutomationState();

  return NextResponse.json({
    proxyRotationEnabled: state.settings.proxyRotationEnabled,
    items: proxies,
  });
}

export async function DELETE(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as { id?: string };
  const id = payload.id?.trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const result = await deleteParquetRecords("proxies", (record) => record.id === id);

  if (result.deletedCount === 0) {
    return NextResponse.json({ error: "Proxy not found" }, { status: 404 });
  }

  const proxies = await readParquetRecords("proxies");
  const state = await readAutomationState();

  return NextResponse.json({
    success: true,
    deletedCount: result.deletedCount,
    proxyRotationEnabled: state.settings.proxyRotationEnabled,
    items: proxies,
  });
}
