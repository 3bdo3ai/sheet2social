import { NextRequest, NextResponse } from 'next/server';

// Helper to get environment variables with validation
function getEnvVars() {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('Missing required Supabase environment variables. Please check your .env.local file.');
  }

  return {
    SUPABASE_URL,
    SERVICE_ROLE_KEY,
    PUBLIC_URL: `${SUPABASE_URL}/storage/v1/object/public/Content/content.json`,
    STORAGE_API_URL: `${SUPABASE_URL}/storage/v1/object/Content/content.json`
  };
}

export async function PUT(request: NextRequest) {
  try {
    const { PUBLIC_URL, STORAGE_API_URL, SERVICE_ROLE_KEY } = getEnvVars();
    const { priceData } = await request.json();

    if (!Array.isArray(priceData)) {
      return NextResponse.json({ error: 'Price data must be an array' }, { status: 400 });
    }

    for (const item of priceData) {
      if (!item.productValue || !item.transferAmount || !item.firstPayment) {
        return NextResponse.json({ error: 'Each price item must have productValue, transferAmount, and firstPayment' }, { status: 400 });
      }
    }

    // Fetch current remote content
    const res = await fetch(PUBLIC_URL);
    if (!res.ok) {
      console.error('Failed to fetch remote content for price update:', res.statusText);
      return NextResponse.json({ error: 'Failed to fetch remote content' }, { status: 502 });
    }
    const content = await res.json();

    // Update priceData
    content.priceData = priceData;

    // Write updated content back to Supabase storage
    const upsertRes = await fetch(STORAGE_API_URL, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(content),
    });

    if (!upsertRes.ok) {
      const text = await upsertRes.text();
      console.error('Failed to write updated content to Supabase:', upsertRes.status, text);
      return NextResponse.json({ error: 'Failed to update remote content' }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating price data:', error);
    return NextResponse.json({ error: 'Failed to update price data' }, { status: 500 });
  }
}