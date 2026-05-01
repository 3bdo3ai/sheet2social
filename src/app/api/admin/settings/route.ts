import { NextResponse } from "next/server";

import { readAutomationState, writeAutomationSettings } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const state = await readAutomationState();
  return NextResponse.json(state.settings);
}

export async function PUT(request: Request) {
  const body = (await request.json()) as {
    parallelAccounts?: number;
    waitIntervalMinutes?: number;
    delayBetweenAccountsMinutes?: number;
    postsPerGroup?: number;
    maxPostsPerAccountPerCycle?: number;
    postsPerSession?: number;
    commentWithPostImage?: boolean;
    proxyRotationEnabled?: boolean;
    visibleBrowser?: boolean;
  };

  const nextSettings: {
    parallelAccounts?: number;
    waitIntervalMinutes?: number;
    delayBetweenAccountsMinutes?: number;
    postsPerGroup?: number;
    maxPostsPerAccountPerCycle?: number;
    postsPerSession?: number;
    commentWithPostImage?: boolean;
    proxyRotationEnabled?: boolean;
    visibleBrowser?: boolean;
  } = {};

  if (body.parallelAccounts !== undefined) {
    const value = Number(body.parallelAccounts);
    if (!Number.isFinite(value) || value <= 0) {
      return NextResponse.json({ error: "parallelAccounts must be a positive number" }, { status: 400 });
    }
    nextSettings.parallelAccounts = value;
  }

  if (body.waitIntervalMinutes !== undefined) {
    const value = Number(body.waitIntervalMinutes);
    if (!Number.isFinite(value) || value <= 0) {
      return NextResponse.json({ error: "waitIntervalMinutes must be a positive number" }, { status: 400 });
    }
    nextSettings.waitIntervalMinutes = value;
  }

  if (body.delayBetweenAccountsMinutes !== undefined) {
    const value = Number(body.delayBetweenAccountsMinutes);
    if (!Number.isFinite(value) || value < 0) {
      return NextResponse.json(
        { error: "delayBetweenAccountsMinutes must be zero or a positive number" },
        { status: 400 }
      );
    }
    nextSettings.delayBetweenAccountsMinutes = value;
  }

  if (body.postsPerGroup !== undefined) {
    const value = Number(body.postsPerGroup);
    if (!Number.isFinite(value) || value <= 0) {
      return NextResponse.json({ error: "postsPerGroup must be a positive number" }, { status: 400 });
    }
    nextSettings.postsPerGroup = value;
  }

  if (body.maxPostsPerAccountPerCycle !== undefined) {
    const value = Number(body.maxPostsPerAccountPerCycle);
    if (!Number.isFinite(value) || value <= 0) {
      return NextResponse.json(
        { error: "maxPostsPerAccountPerCycle must be a positive number" },
        { status: 400 }
      );
    }
    nextSettings.maxPostsPerAccountPerCycle = value;
  }

  if (body.postsPerSession !== undefined) {
    const value = Number(body.postsPerSession);
    if (!Number.isFinite(value) || value <= 0) {
      return NextResponse.json({ error: "postsPerSession must be a positive number" }, { status: 400 });
    }
    nextSettings.postsPerSession = value;
  }

  if (typeof body.commentWithPostImage === "boolean") {
    nextSettings.commentWithPostImage = body.commentWithPostImage;
  }

  if (typeof body.proxyRotationEnabled === "boolean") {
    nextSettings.proxyRotationEnabled = body.proxyRotationEnabled;
  }

  if (typeof body.visibleBrowser === "boolean") {
    nextSettings.visibleBrowser = body.visibleBrowser;
  }

  if (Object.keys(nextSettings).length === 0) {
    return NextResponse.json({ error: "No valid settings provided" }, { status: 400 });
  }

  const nextState = await writeAutomationSettings(nextSettings);

  return NextResponse.json(nextState.settings);
}
