import { api } from "@/lib/api";
import { cookies } from "next/headers";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Ticket {
  id: string;
  source: string;
  type: string;
  priority: string;
  status: string;
  subject: string;
  slaDeadline: string | null;
  slaBreached: boolean;
  createdAt: string;
  assignedTo: string | null;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

const priorityVariant: Record<string, "default" | "destructive" | "secondary" | "outline"> = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
};

export default async function TicketsPage() {
  const tenantId = await getTenantId();
  let tickets: Ticket[] = [];

  if (tenantId) {
    try {
      const data = await api<{ tickets: Ticket[] }>(`/admin/tickets/${tenantId}?limit=50`);
      tickets = data.tickets;
    } catch { /* API offline */ }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Tickets</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>SLA</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No tickets
                  </TableCell>
                </TableRow>
              ) : (
                tickets.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Link href={`/tickets/${t.id}`} className="hover:underline text-sm">
                        {t.subject}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{t.type}</TableCell>
                    <TableCell>
                      <Badge variant={priorityVariant[t.priority] ?? "default"}>{t.priority}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{t.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {t.slaBreached ? (
                        <Badge variant="destructive">Breached</Badge>
                      ) : t.slaDeadline ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {new Date(t.slaDeadline).toLocaleString()}
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(t.createdAt).toLocaleString()}
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
