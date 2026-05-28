import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const TENANT_SLUG_LOCK = process.env.NEXT_PUBLIC_TENANT_SLUG_LOCK;

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Record<string, unknown>;

  try {
    const response = await fetch(`${API_URL}/admin/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // In sub-portal deployments, force tenantSlug so users from other
      // tenants can't authenticate here even if they hit this URL.
      body: JSON.stringify({
        ...body,
        ...(TENANT_SLUG_LOCK ? { tenantSlug: TENANT_SLUG_LOCK } : {}),
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return NextResponse.json(
        { success: false, error: (err as { error?: string }).error ?? "Invalid credentials" },
        { status: 401 },
      );
    }

    const data = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
      agent: Record<string, unknown>;
    };

    const cookieStore = await cookies();
    cookieStore.set("af_token", data.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24,
      path: "/",
    });

    cookieStore.set("af_user", JSON.stringify(data.agent), {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24,
      path: "/",
    });

    return NextResponse.json({ success: true, agent: data.agent });
  } catch {
    return NextResponse.json(
      { success: false, error: "Connection failed" },
      { status: 500 },
    );
  }
}
