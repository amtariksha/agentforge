import { redirect } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { isSuperAdmin } from "@/lib/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  isActive: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  config: Record<string, unknown>;
}

interface AgentTypeSummary {
  id: string;
  slug: string;
  name: string;
  shadowMode: boolean | null;
  isActive: boolean | null;
}

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await isSuperAdmin())) redirect("/");

  const { id } = await params;

  let tenant: TenantDetail | null = null;
  let agents: AgentTypeSummary[] = [];
  let error: string | null = null;

  try {
    [tenant, agents] = await Promise.all([
      api<TenantDetail>(`/admin/tenants/${id}`),
      api<AgentTypeSummary[]>(`/admin/tenants/${id}/agents`).catch(() => []),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load tenant";
  }

  if (error || !tenant) {
    return (
      <div className="space-y-4">
        <Link href="/tenants" className="text-sm text-muted-foreground hover:underline">
          ← Back to tenants
        </Link>
        <Card>
          <CardContent className="p-6 text-sm text-destructive">{error ?? "Tenant not found"}</CardContent>
        </Card>
      </div>
    );
  }

  const exportUrl = `/admin/tenants/${id}/export`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/tenants" className="text-sm text-muted-foreground hover:underline">
            ← Back to tenants
          </Link>
          <h1 className="text-2xl font-medium tracking-tight mt-2">{tenant.name}</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className="font-mono text-xs text-muted-foreground">{tenant.slug}</span>
            <Badge variant={tenant.isActive ? "default" : "secondary"}>
              {tenant.isActive ? "active" : "inactive"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Created {tenant.createdAt ? new Date(tenant.createdAt).toLocaleDateString() : "—"}
            </span>
          </div>
        </div>
        <Link href={`${process.env.API_URL ?? ""}${exportUrl}`}>
          <Button variant="outline" size="sm">Export config</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent types ({agents.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No agent types yet. Switch to this tenant from the header to create one.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {agents.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{a.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{a.slug}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.shadowMode && <Badge variant="secondary">shadow</Badge>}
                    {!a.isActive && <Badge variant="secondary">inactive</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-auto rounded-md bg-muted p-4 text-xs">
            {JSON.stringify(tenant.config, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
