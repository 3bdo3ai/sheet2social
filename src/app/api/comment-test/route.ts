import { NextResponse } from "next/server";

import { inspectCommentCandidates, runCommentTest } from "@/lib/commentTest";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      accountId?: string;
      groupId?: string;
      rowIndex?: number;
      commentLink?: string;
      visible?: boolean;
      captureMatchedPostScreenshot?: boolean;
      mode?: "run" | "inspect";
      articleIndex?: number;
    };

    const accountId = payload.accountId?.trim();
    const groupId = payload.groupId?.trim();

    if (!accountId || !groupId) {
      return NextResponse.json({ error: "accountId and groupId are required" }, { status: 400 });
    }

    if (payload.mode === "inspect") {
      const result = await inspectCommentCandidates({
        accountId,
        groupId,
        rowIndex: Number.isInteger(payload.rowIndex) ? payload.rowIndex : undefined,
        commentLink: payload.commentLink?.trim() || undefined,
        visible: payload.visible === true,
      });

      return NextResponse.json(result);
    }

    const result = await runCommentTest({
      accountId,
      groupId,
      rowIndex: Number.isInteger(payload.rowIndex) ? payload.rowIndex : undefined,
      commentLink: payload.commentLink?.trim() || undefined,
      visible: payload.visible === true,
      captureMatchedPostScreenshot: payload.captureMatchedPostScreenshot !== false,
      articleIndex: Number.isInteger(payload.articleIndex) ? payload.articleIndex : undefined,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error while testing comment flow",
      },
      { status: 500 }
    );
  }
}