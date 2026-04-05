import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Operator {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  maxConcurrentChats: number | null;
  skills: string[] | null;
  isActive: boolean | null;
  activeChats: number;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

const statusColor: Record<string, "default" | "destructive" | "secondary"> = {
  online: "default",
  busy: "destructive",
  offline: "secondary",
};

export default async function OperatorsPage() {
  const tenantId = await getTenantId();
  let operators: Operator[] = [];

  if (tenantId) {
    try { operators = await api<Operator[]>(`/admin/agents/${tenantId}`); } catch { /* */ }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Operators</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Skills</TableHead>
                <TableHead className="text-right">Active Chats</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {operators.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No operators</TableCell></TableRow>
              ) : (
                operators.map((op) => (
                  <TableRow key={op.id}>
                    <TableCell className="font-medium text-sm">{op.name}</TableCell>
                    <TableCell className="font-mono text-xs">{op.email}</TableCell>
                    <TableCell><Badge variant="outline">{op.role}</Badge></TableCell>
                    <TableCell><Badge variant={statusColor[op.status] ?? "secondary"}>{op.status}</Badge></TableCell>
                    <TableCell className="text-xs">{op.skills?.join(", ") ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono">{op.activeChats}/{op.maxConcurrentChats ?? 5}</TableCell>
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
