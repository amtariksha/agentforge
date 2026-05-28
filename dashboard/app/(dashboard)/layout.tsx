import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { api } from "@/lib/api";
import { getTenantSlugLock } from "@/lib/tenant";

interface SessionUser {
  name?: string;
  tenantId?: string;
  role?: string;
}

interface TenantOption {
  id: string;
  name: string;
  slug: string;
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get("af_token")?.value;
  const userRaw = cookieStore.get("af_user")?.value;
  const activeTenantId = cookieStore.get("af_active_tenant_id")?.value;

  if (!token) redirect("/login");

  let user: SessionUser = {};
  try {
    user = userRaw ? (JSON.parse(userRaw) as SessionUser) : {};
  } catch {
    /* ignore */
  }

  // Sub-portal mode: dashboard is locked to one tenant — never show switcher.
  // Otherwise, super-admins get a switcher loaded with all tenants.
  const slugLock = getTenantSlugLock();
  const isSuperAdmin = user.role === "super_admin" && !slugLock;

  let tenants: TenantOption[] = [];
  let activeTenantLabel: string | undefined;
  if (isSuperAdmin) {
    try {
      tenants = await api<TenantOption[]>("/admin/tenants");
      const active = tenants.find((t) => t.id === (activeTenantId ?? user.tenantId));
      activeTenantLabel = active?.name ?? "Platform";
    } catch {
      /* the api call may fail before super-admin token is fully wired — degrade silently */
    }
  } else {
    activeTenantLabel = user.tenantId;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar isSuperAdmin={isSuperAdmin} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          userName={user.name}
          tenantLabel={activeTenantLabel}
          isSuperAdmin={isSuperAdmin}
          tenants={tenants}
          activeTenantId={activeTenantId ?? user.tenantId}
        />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
