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
  };

  const parallelAccounts = Number(body.parallelAccounts);
  const waitIntervalMinutes = Number(body.waitIntervalMinutes);
  const delayBetweenAccountsMinutes = Number(body.delayBetweenAccountsMinutes);
  const postsPerGroup = Number(body.postsPerGroup);
  const maxPostsPerAccountPerCycle = Number(body.maxPostsPerAccountPerCycle);
  const postsPerSession = Number(body.postsPerSession);

  if (
    !parallelAccounts ||
    !waitIntervalMinutes ||
    Number.isNaN(delayBetweenAccountsMinutes) ||
    !postsPerGroup ||
    !maxPostsPerAccountPerCycle ||
    !postsPerSession
  ) {
    return NextResponse.json(
      {
        error:
          "parallelAccounts, waitIntervalMinutes, delayBetweenAccountsMinutes, postsPerGroup, maxPostsPerAccountPerCycle, and postsPerSession are required",
      },
      { status: 400 }
    );
  }

  const nextState = await writeAutomationSettings({
    parallelAccounts,
    waitIntervalMinutes,
    delayBetweenAccountsMinutes,
    postsPerGroup,
    maxPostsPerAccountPerCycle,
    postsPerSession,
    commentWithPostImage: body.commentWithPostImage ?? false,
    proxyRotationEnabled: body.proxyRotationEnabled,
  });

  return NextResponse.json(nextState.settings);
}
