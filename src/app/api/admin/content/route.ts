import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

// Helper to get environment variables with validation
const LOCAL_CONTENT_PATH = path.join(process.cwd(), "src", "content", "content.json");

function getEnvVars() {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    return null;
  }

  return {
    SUPABASE_URL,
    ANON_KEY,
    SERVICE_ROLE_KEY,
    PUBLIC_URL: `${SUPABASE_URL}/storage/v1/object/public/Content/content.json`,
    STORAGE_API_URL: `${SUPABASE_URL}/storage/v1/object/Content/content.json`
  };
}

async function readLocalContent() {
  const raw = await fs.readFile(LOCAL_CONTENT_PATH, "utf8");
  return JSON.parse(raw);
}

async function writeLocalContent(content: unknown) {
  await fs.writeFile(LOCAL_CONTENT_PATH, JSON.stringify(content, null, 2), "utf8");
}

export async function GET() {
  try {
    const env = getEnvVars();

    if (!env) {
      const content = await readLocalContent();
      return NextResponse.json(content);
    }

    const res = await fetch(env.PUBLIC_URL, { headers: { apikey: env.ANON_KEY } });
    if (!res.ok) {
      const localContent = await readLocalContent();
      return NextResponse.json(localContent);
    }

    const content = await res.json();
    return NextResponse.json(content);
  } catch (error) {
    console.error("Error fetching content:", error);
    return NextResponse.json({ error: "Failed to read content" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const newContent = await request.json();
    if (!newContent || typeof newContent !== "object") {
      return NextResponse.json({ error: "Invalid content format" }, { status: 400 });
    }

    const env = getEnvVars();

    if (!env) {
      await writeLocalContent(newContent);
      return NextResponse.json({ success: true, source: "local" });
    }

    const upsertRes = await fetch(env.STORAGE_API_URL, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(newContent),
    });

    if (!upsertRes.ok) {
      const text = await upsertRes.text();
      console.error("Failed to write content to Supabase:", upsertRes.status, text);
      return NextResponse.json({ error: "Failed to update remote content" }, { status: 502 });
    }

    return NextResponse.json({ success: true, source: "supabase" });
  } catch (error) {
    console.error("Error updating content:", error);
    return NextResponse.json({ error: "Failed to update content" }, { status: 500 });
  }
}