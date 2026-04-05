import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Tool {
  id: string;
  name: string;
  description: string;
  category: string;
  requiresHitl: boolean;
  requiresUserConfirm: boolean;
  isActive: boolean | null;
  backendMapping: { type: string; handler?: string; endpoint?: string };
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

const categoryVariant: Record<string, "default" | "destructive" | "secondary"> = {
  read: "secondary",
  write: "default",
  destructive: "destructive",
};

export default async function ToolsPage() {
  const tenantId = await getTenantId();
  let tools: Tool[] = [];

  if (tenantId) {
    try { tools = await api<Tool[]>(`/admin/tenants/${tenantId}/tools`); } catch { /* */ }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Tools</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Backend</TableHead>
                <TableHead>HITL</TableHead>
                <TableHead>User Confirm</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No tools configured</TableCell>
                </TableRow>
              ) : (
                tools.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="font-medium text-sm">{t.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 max-w-[300px] truncate">{t.description}</div>
                    </TableCell>
                    <TableCell><Badge variant={categoryVariant[t.category] ?? "default"}>{t.category}</Badge></TableCell>
                    <TableCell>
                      <Badge variant="outline">{t.backendMapping.type}</Badge>
                      <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
                        {t.backendMapping.handler ?? t.backendMapping.endpoint ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell>{t.requiresHitl ? "Yes" : "No"}</TableCell>
                    <TableCell>{t.requiresUserConfirm ? "Yes" : "No"}</TableCell>
                    <TableCell><Badge variant={t.isActive ? "default" : "secondary"}>{t.isActive ? "Active" : "Inactive"}</Badge></TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
