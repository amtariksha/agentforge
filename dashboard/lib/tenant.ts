/**
 * Active-tenant resolution for the dashboard.
 *
 * For non-super-admin users: the active tenant is their JWT tenant (from
 * the `af_user` cookie). The `af_active_tenant_id` cookie is ignored by the
 * server for these users (auth middleware enforces this).
 *
 * For super-admins: `af_active_tenant_id` (set by the header tenant switcher)
 * is the active tenant; if absent, falls back to JWT tenant.
 */
import { cookies } from "next/headers";

interface SessionUser {
  id?: string;
  tenantId?: string;
  role?: string;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const raw = (await cookies()).get("af_user")?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export async function getActiveTenantId(): Promise<string | null> {
  const cookieStore = await cookies();
  const user = await getSessionUser();
  if (!user) return null;

  if (user.role === "super_admin") {
    const override = cookieStore.get("af_active_tenant_id")?.value;
    if (override) return override;
  }
  return user.tenantId ?? null;
}

export async function isSuperAdmin(): Promise<boolean> {
  return (await getSessionUser())?.role === "super_admin";
}

/**
 * In sub-portal deployments, NEXT_PUBLIC_TENANT_SLUG_LOCK locks the dashboard
 * to a single tenant. The header switcher is hidden and the login form
 * pre-fills the tenant. The server still enforces tenant scoping by JWT.
 */
export function getTenantSlugLock(): string | null {
  const lock = process.env.NEXT_PUBLIC_TENANT_SLUG_LOCK;
  return lock && lock.length > 0 ? lock : null;
}
