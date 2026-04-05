import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface WebhookConfig {
  id: string;
  url: string;
  events: string[] | null;
  isActive: boolean | null;
  createdAt: string;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

export default async function WebhooksPage() {
  const tenantId = await getTenantId();
  let webhooks: WebhookConfig[] = [];

  if (tenantId) {
    try { webhooks = await api<WebhookConfig[]>(`/admin/webhooks/${tenantId}`); } catch { /* */ }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Outbound Webhooks</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>URL</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {webhooks.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-8">No webhooks</TableCell></TableRow>
              ) : (
                webhooks.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-mono text-xs">{w.url}</TableCell>
                    <TableCell className="flex flex-wrap gap-1">
                      {w.events?.map((e) => <Badge key={e} variant="outline" className="text-[10px]">{e}</Badge>)}
                    </TableCell>
                    <TableCell><Badge variant={w.isActive ? "default" : "secondary"}>{w.isActive ? "Active" : "Inactive"}</Badge></TableCell>
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
