"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface HeaderProps {
  userName?: string;
  tenantName?: string;
}

export function Header({ userName, tenantName }: HeaderProps) {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-6">
      <div className="flex items-center gap-3">
        {tenantName && (
          <span className="rounded-md bg-accent px-2.5 py-1 font-mono text-xs text-muted-foreground">
            {tenantName}
          </span>
        )}
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
