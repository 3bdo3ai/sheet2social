import { NextResponse } from "next/server";

import { requireAdminLicenseSession } from "@/lib/license/auth";
import {
  deleteLicenseRecord,
  extendLicenseRecord,
  forceLogoutLicenseDevice,
  setLicenseStatus,
} from "@/lib/license/admin";
import type { LicenseStatus } from "@/lib/license/types";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function asLicenseStatus(value: unknown): LicenseStatus | null {
  return value === "active" || value === "paused" || value === "expired" || value === "revoked" ? value : null;
}

export async function PATCH(request: Request, context: RouteContext) {
  await requireAdminLicenseSession();

  const { id } = await context.params;
  const payload = (await request.json()) as {
    action?: "extend" | "set-status" | "force-logout";
    addDays?: number;
    validUntil?: string;
    status?: LicenseStatus;
  };

  if (!id) {
    return NextResponse.json({ error: "Key id is required." }, { status: 400 });
  }

  try {
    if (payload.action === "extend") {
      const updated = await extendLicenseRecord({
        id,
        addDays: payload.addDays,
        validUntil: payload.validUntil,
      });

      return NextResponse.json(updated);
    }

    if (payload.action === "set-status") {
      const status = asLicenseStatus(payload.status);
      if (!status) {
        return NextResponse.json({ error: "A valid status is required." }, { status: 400 });
      }

      const updated = await setLicenseStatus({ id, status });
      return NextResponse.json(updated);
    }

    if (payload.action === "force-logout") {
      const updated = await forceLogoutLicenseDevice(id);
      return NextResponse.json(updated);
    }

    return NextResponse.json({ error: "Invalid action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update key.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_: Request, context: RouteContext) {
  await requireAdminLicenseSession();

  const { id } = await context.params;

  if (!id) {
    return NextResponse.json({ error: "Key id is required." }, { status: 400 });
  }

  try {
    await deleteLicenseRecord(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete key.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
