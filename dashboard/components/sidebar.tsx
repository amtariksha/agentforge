"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  superAdminOnly?: boolean;
}

const navItems: NavItem[] = [
  { href: "/", label: "Overview", icon: "📊" },
  { href: "/tenants", label: "Tenants", icon: "🏢", superAdminOnly: true },
  { href: "/conversations", label: "Conversations", icon: "💬" },
  { href: "/tickets", label: "Tickets", icon: "🎫" },
  { href: "/live-chat", label: "Live Chat", icon: "🔴" },
  { href: "/approvals", label: "Approvals", icon: "✅" },
  { href: "/agents", label: "Agent Types", icon: "🤖" },
  { href: "/tools", label: "Tools", icon: "🔧" },
  { href: "/guardrails", label: "Guardrails", icon: "🛡️" },
  { href: "/corrections", label: "Corrections", icon: "✏️" },
  { href: "/knowledge", label: "Knowledge Base", icon: "📚" },
  { href: "/operators", label: "Operators", icon: "👥" },
  { href: "/webhooks", label: "Webhooks", icon: "🔗" },
  { href: "/analytics", label: "Analytics", icon: "📈" },
  { href: "/billing", label: "Billing", icon: "💰" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
];

interface SidebarProps {
  isSuperAdmin?: boolean;
}

export function Sidebar({ isSuperAdmin = false }: SidebarProps) {
  const pathname = usePathname();
  const items = navItems.filter((item) => !item.superAdminOnly || isSuperAdmin);

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-card">
      <div className="flex h-14 items-center border-b border-border px-4">
        <Link href="/" className="text-lg font-medium tracking-tight">
          AgentForge
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-0.5">
          {items.map((item) => {
            const isActive =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <span className="text-base leading-none">{item.icon}</span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
