"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface TenantOption {
  id: string;
  name: string;
  slug: string;
}

interface HeaderProps {
  userName?: string;
  tenantLabel?: string;
  isSuperAdmin?: boolean;
  tenants?: TenantOption[];
  activeTenantId?: string;
}

export function Header({
  userName,
  tenantLabel,
  isSuperAdmin = false,
  tenants = [],
  activeTenantId,
}: HeaderProps) {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  async function handleSwitchTenant(tenantId: string) {
    if (switching || tenantId === activeTenantId) return;
    setSwitching(true);
    try {
      await fetch("/api/active-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      router.refresh();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-6">
      <div className="flex items-center gap-3">
        {isSuperAdmin && tenants.length > 0 ? (
          <select
            value={activeTenantId ?? ""}
            onChange={(e) => handleSwitchTenant(e.target.value)}
            disabled={switching}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="Switch tenant"
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : tenantLabel ? (
          <span className="rounded-md bg-accent px-2.5 py-1 font-mono text-xs text-muted-foreground">
            {tenantLabel}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-4">
        {userName && (
          <span className="text-sm text-muted-foreground">{userName}</span>
        )}
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
