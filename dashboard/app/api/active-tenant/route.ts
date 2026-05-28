import { NextResponse } from "next/server";
import { cookies } from "next/headers";

/**
 * Set or clear the super-admin's active tenant override.
 * Body: { tenantId: string | null }
 *
 * The server enforces that this cookie has no effect for non-super-admin
 * tokens (see src/shared/middleware/auth.ts). But we still gate this route
 * defensively to avoid littering cookies for non-super-admins.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userRaw = cookieStore.get("af_user")?.value;
  let role: string | undefined;
  try {
    role = userRaw ? (JSON.parse(userRaw) as { role?: string }).role : undefined;
  } catch {
    /* ignore */
  }
  if (role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { tenantId?: string | null };
  if (!body.tenantId) {
    cookieStore.delete("af_active_tenant_id");
  } else {
    cookieStore.set("af_active_tenant_id", body.tenantId, {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24, // 24h, same as session
      path: "/",
    });
  }
  return NextResponse.json({ success: true });
}
