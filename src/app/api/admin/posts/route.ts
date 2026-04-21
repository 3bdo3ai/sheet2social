import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  appendCsvPost,
  deleteCsvPostByIndex,
  readCsvPosts,
  writeCsvPosts,
  updateCsvPostByIndex,
} from "@/lib/csvPosts";
import { parseCsv, normalizeCsvHeader } from "@/lib/csvImport";
import { initializeDbStorage, readParquetRecords } from "@/lib/db";
import { getRuntimeImageDir } from "@/lib/runtimePaths";

export const runtime = "nodejs";

const IMAGE_DIR = getRuntimeImageDir();

export async function GET() {
  await initializeDbStorage();

  const groups = await readParquetRecords("fbGroups");
  const rows = await Promise.all(
    groups.map(async (group) => {
      const posts = await readCsvPosts(group.csvPath);
      return posts.map((post) => ({
        id: `${group.id}-${post.rowIndex}`,
        groupId: group.id,
        groupLabel: group.name || group.groupId,
        ...post,
      }));
    })
  );

  return NextResponse.json(rows.flat());
}

export async function POST(request: Request) {
  await initializeDbStorage();

  const formData = await request.formData();
  const action = String(formData.get("action") ?? "single").trim();

  if (action === "bulk") {
    const groupId = String(formData.get("groupId") ?? "").trim();
    const file = formData.get("file");

    if (!groupId) {
      return NextResponse.json({ error: "groupId is required" }, { status: 400 });
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "CSV file is required" }, { status: 400 });
    }

    const groups = await readParquetRecords("fbGroups");
    const group = groups.find((item) => item.id === groupId);

    if (!group) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }

    const csvText = await file.text();
    const parsed = parseCsv(csvText);
    const normalizedHeaders = parsed.headers.map((header) => normalizeCsvHeader(header));
    const requiredHeaders = ["post_text", "comment_link", "status"];
    const hasAllRequiredHeaders = requiredHeaders.every((header) => normalizedHeaders.includes(header));
    const hasImageHeader = normalizedHeaders.includes("image_url") || normalizedHeaders.includes("url");

    if (!hasAllRequiredHeaders || !hasImageHeader) {
      return NextResponse.json(
        {
          error:
            "Invalid CSV schema. Required headers: post_text and one of (image_url,url), plus comment_link,status",
        },
        { status: 400 }
      );
    }

    const validRows = parsed.rows
      .map((row) => ({
        post_text: row.post_text,
        image_url: String(row.image_url ?? row.url ?? ""),
        comment_link: row.comment_link,
        status: row.status,
      }))
      .filter((row) => row.post_text.trim().length > 0);

    if (validRows.length === 0) {
      return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
    }

    const existing = await readCsvPosts(group.csvPath);
    await writeCsvPosts(group.csvPath, [
      ...existing.map((item) => ({
        post_text: item.post_text,
        image_url: item.image_url,
        comment_link: item.comment_link,
        status: item.status,
      })),
      ...validRows,
    ]);

    return NextResponse.json({ success: true, importedCount: validRows.length }, { status: 201 });
  }

  const groupId = String(formData.get("groupId") ?? "").trim();
  const postText = String(formData.get("postText") ?? "").trim();
  const commentLink = String(formData.get("commentLink") ?? "").trim();
  const imageUrlInput = String(formData.get("imageUrl") ?? "").trim();
  const addComment = String(formData.get("addComment") ?? "false") === "true";
  const image = formData.get("image");

  if (!groupId || !postText) {
    return NextResponse.json(
      { error: "groupId and postText are required" },
      { status: 400 }
    );
  }

  const groups = await readParquetRecords("fbGroups");
  const group = groups.find((item) => item.id === groupId);

  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  let imageUrl = imageUrlInput;
  if (!imageUrl && image instanceof File && image.size > 0) {
    await fs.mkdir(IMAGE_DIR, { recursive: true });
    const ext = path.extname(image.name) || ".jpg";
    const fileName = `${randomUUID()}${ext}`;
    const outputPath = path.join(IMAGE_DIR, fileName);
    await fs.writeFile(outputPath, Buffer.from(await image.arrayBuffer()));
    imageUrl = path.join("data", "images", fileName).replace(/\\/g, "/");
  }

  await appendCsvPost(group.csvPath, {
    post_text: postText,
    image_url: imageUrl,
    comment_link: addComment ? commentLink : "",
    status: "",
  });

  return NextResponse.json({ success: true }, { status: 201 });
}

export async function PUT(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as {
    id?: string;
    postText?: string;
    imageUrl?: string;
    commentLink?: string;
    status?: string;
  };

  const id = payload.id?.trim();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const splitIndex = id.lastIndexOf("-");
  if (splitIndex < 0) {
    return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  }

  const groupId = id.slice(0, splitIndex);
  const rowIndex = Number(id.slice(splitIndex + 1));

  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  }

  const groups = await readParquetRecords("fbGroups");
  const group = groups.find((item) => item.id === groupId);

  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const updated = await updateCsvPostByIndex(group.csvPath, rowIndex, {
    post_text: payload.postText,
    image_url: payload.imageUrl,
    comment_link: payload.commentLink,
    status: payload.status,
  });

  if (!updated) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(request: Request) {
  await initializeDbStorage();

  const payload = (await request.json()) as { id?: string };
  const id = payload.id?.trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const splitIndex = id.lastIndexOf("-");
  if (splitIndex < 0) {
    return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  }

  const groupId = id.slice(0, splitIndex);
  const rowIndex = Number(id.slice(splitIndex + 1));

  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  }

  const groups = await readParquetRecords("fbGroups");
  const group = groups.find((item) => item.id === groupId);

  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const deleted = await deleteCsvPostByIndex(group.csvPath, rowIndex);
  if (!deleted) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
