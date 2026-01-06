import { NextRequest, NextResponse } from 'next/server';

// Helper to get environment variables with validation
function getEnvVars() {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error('Missing required Supabase environment variables. Please check your .env.local file.');
  }

  return {
    SUPABASE_URL,
    ANON_KEY,
    SERVICE_ROLE_KEY,
    PUBLIC_URL: `${SUPABASE_URL}/storage/v1/object/public/Content/content.json`,
    STORAGE_API_URL: `${SUPABASE_URL}/storage/v1/object/Content/content.json`
  };
}

export async function GET() {
  try {
    const { PUBLIC_URL, ANON_KEY } = getEnvVars();
    const res = await fetch(PUBLIC_URL, { headers: { apikey: ANON_KEY } });
    if (!res.ok) {
      console.error('Failed fetching remote content:', res.statusText);
      return NextResponse.json({ error: 'Failed to fetch remote content' }, { status: 502 });
    }
    const content = await res.json();
    return NextResponse.json(content);
  } catch (error) {
    console.error('Error fetching content from Supabase:', error);
    return NextResponse.json({ error: 'Failed to read content' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { STORAGE_API_URL, SERVICE_ROLE_KEY } = getEnvVars();
    const newContent = await request.json();
    if (!newContent || typeof newContent !== 'object') {
      return NextResponse.json({ error: 'Invalid content format' }, { status: 400 });
    }

    // Write to Supabase storage using service role key
    const upsertRes = await fetch(STORAGE_API_URL, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(newContent),
    });

    if (!upsertRes.ok) {
      const text = await upsertRes.text();
      console.error('Failed to write content to Supabase:', upsertRes.status, text);
      return NextResponse.json({ error: 'Failed to update remote content' }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating remote content:', error);
    return NextResponse.json({ error: 'Failed to update content' }, { status: 500 });
  }
}