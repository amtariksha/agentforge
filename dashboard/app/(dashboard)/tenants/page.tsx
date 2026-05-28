import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { isSuperAdmin } from "@/lib/tenant";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import Link from "next/link";

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean | null;
  createdAt: string | null;
}

export default async function TenantsPage() {
  // Server-side gate — tenant management is super-admin only.
  if (!(await isSuperAdmin())) {
    redirect("/");
  }

  let tenants: TenantRow[] = [];
  let error: string | null = null;
  try {
    tenants = await api<TenantRow[]>("/admin/tenants");
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load tenants";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Tenants</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Platform-wide tenant management. Switch tenants from the header to act inside a specific tenant.
          </p>
        </div>
        <Link href="/tenants/new">
          <Button>Create Tenant</Button>
        </Link>
      </div>

      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6 text-sm text-destructive">{error}</div>
          ) : tenants.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No tenants yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{t.slug}</TableCell>
                    <TableCell>
                      <Badge variant={t.isActive ? "default" : "secondary"}>
                        {t.isActive ? "active" : "inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/tenants/${t.id}`} className="text-sm text-primary hover:underline">
                        Details
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
