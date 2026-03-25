import { NextResponse } from "next/server";

import { readAutomationState, writeAutomationState } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const state = await readAutomationState();
  return NextResponse.json({ state: state.state });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { state?: "running" | "stopped" };

  if (body.state !== "running" && body.state !== "stopped") {
    return NextResponse.json(
      { error: "state must be running or stopped" },
      { status: 400 }
    );
  }

  const next = await writeAutomationState(body.state);
  return NextResponse.json({ state: next.state });
}
