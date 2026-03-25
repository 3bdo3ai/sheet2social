import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  appendCsvPost,
  deleteCsvPostByIndex,
  readCsvPosts,
  updateCsvPostByIndex,
} from "@/lib/csvPosts";
import { initializeDbStorage, readParquetRecords } from "@/lib/db";

export const runtime = "nodejs";

const IMAGE_DIR = path.join(process.cwd(), "data", "images");

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
  const groupId = String(formData.get("groupId") ?? "").trim();
  const postText = String(formData.get("postText") ?? "").trim();
  const commentLink = String(formData.get("commentLink") ?? "").trim();
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

  let imageUrl = "";
  if (image instanceof File && image.size > 0) {
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
