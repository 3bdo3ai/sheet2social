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
    commentWithPostImage?: boolean;
    proxyRotationEnabled?: boolean;
  };

  const parallelAccounts = Number(body.parallelAccounts);
  const waitIntervalMinutes = Number(body.waitIntervalMinutes);
  const delayBetweenAccountsMinutes = Number(body.delayBetweenAccountsMinutes);
  const postsPerGroup = Number(body.postsPerGroup);

  if (
    !parallelAccounts ||
    !waitIntervalMinutes ||
    Number.isNaN(delayBetweenAccountsMinutes) ||
    !postsPerGroup
  ) {
    return NextResponse.json(
      {
        error:
          "parallelAccounts, waitIntervalMinutes, delayBetweenAccountsMinutes, and postsPerGroup are required",
      },
      { status: 400 }
    );
  }

  const nextState = await writeAutomationSettings({
    parallelAccounts,
    waitIntervalMinutes,
    delayBetweenAccountsMinutes,
    postsPerGroup,
    commentWithPostImage: body.commentWithPostImage ?? false,
    proxyRotationEnabled: body.proxyRotationEnabled,
  });

  return NextResponse.json(nextState.settings);
}
