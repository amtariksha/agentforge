import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Approval {
  id: string;
  tenantId: string;
  conversationId: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  reason: string;
  status: string;
  createdAt: string;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

export default async function ApprovalsPage() {
  const tenantId = await getTenantId();
  let approvals: Approval[] = [];

  if (tenantId) {
    try { approvals = await api<Approval[]>(`/admin/approvals/${tenantId}`); } catch { /* */ }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-medium tracking-tight">HITL Approvals</h1>
        <Badge variant={approvals.length > 0 ? "destructive" : "secondary"}>
          {approvals.length} pending
        </Badge>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>Parameters</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No pending approvals
                  </TableCell>
                </TableRow>
              ) : (
                approvals.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-sm">{a.toolName}</TableCell>
                    <TableCell className="font-mono text-xs max-w-[200px] truncate">
                      {JSON.stringify(a.toolParams)}
                    </TableCell>
                    <TableCell className="text-sm">{a.reason}</TableCell>
                    <TableCell><Badge variant="outline">{a.status}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(a.createdAt).toLocaleString()}
                    </TableCell>
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
