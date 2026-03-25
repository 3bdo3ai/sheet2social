import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

// Helper to get environment variables with validation
const LOCAL_CONTENT_PATH = path.join(process.cwd(), "src", "content", "content.json");

function getEnvVars() {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return null;
  }

  return {
    SUPABASE_URL,
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

export async function PUT(request: NextRequest) {
  try {
    const { priceData } = await request.json();

    if (!Array.isArray(priceData)) {
      return NextResponse.json({ error: 'Price data must be an array' }, { status: 400 });
    }

    for (const item of priceData) {
      if (!item.productValue || !item.transferAmount || !item.firstPayment) {
        return NextResponse.json({ error: 'Each price item must have productValue, transferAmount, and firstPayment' }, { status: 400 });
      }
    }

    const env = getEnvVars();

    if (!env) {
      const localContent = await readLocalContent();
      localContent.priceData = priceData;
      await writeLocalContent(localContent);
      return NextResponse.json({ success: true, source: "local" });
    }

    const res = await fetch(env.PUBLIC_URL);
    if (!res.ok) {
      console.error('Failed to fetch remote content for price update:', res.statusText);
      return NextResponse.json({ error: 'Failed to fetch remote content' }, { status: 502 });
    }

    const content = await res.json();

    content.priceData = priceData;

    const upsertRes = await fetch(env.STORAGE_API_URL, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(content),
    });

    if (!upsertRes.ok) {
      const text = await upsertRes.text();
      console.error('Failed to write updated content to Supabase:', upsertRes.status, text);
      return NextResponse.json({ error: 'Failed to update remote content' }, { status: 502 });
    }

    return NextResponse.json({ success: true, source: "supabase" });
  } catch (error) {
    console.error('Error updating price data:', error);
    return NextResponse.json({ error: 'Failed to update price data' }, { status: 500 });
  }
}