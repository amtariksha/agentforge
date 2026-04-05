import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

interface Ticket {
  id: string;
  source: string;
  type: string;
  priority: string;
  status: string;
  subject: string;
  description: string | null;
  slaDeadline: string | null;
  slaBreached: boolean;
  assignedTo: string | null;
  resolution: { type: string; notes: string; actionsTaken: string[] } | null;
  createdAt: string;
  resolvedAt: string | null;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = await getTenantId();
  let ticket: Ticket | null = null;

  if (tenantId) {
    try { ticket = await api<Ticket>(`/admin/tickets/${tenantId}/${id}`); } catch { /* */ }
  }

  if (!ticket) return <div className="text-muted-foreground">Ticket not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-medium tracking-tight">{ticket.subject}</h1>
        <Badge variant={ticket.priority === "critical" || ticket.priority === "high" ? "destructive" : "default"}>
          {ticket.priority}
        </Badge>
        <Badge variant="outline">{ticket.status}</Badge>
        {ticket.slaBreached && <Badge variant="destructive">SLA Breached</Badge>}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">Details</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><span className="text-muted-foreground">Type: </span>{ticket.type}</div>
            <div><span className="text-muted-foreground">Source: </span>{ticket.source}</div>
            <div><span className="text-muted-foreground">Created: </span>{new Date(ticket.createdAt).toLocaleString()}</div>
            {ticket.slaDeadline && <div><span className="text-muted-foreground">SLA Deadline: </span>{new Date(ticket.slaDeadline).toLocaleString()}</div>}
            {ticket.assignedTo && <div><span className="text-muted-foreground">Assigned To: </span><span className="font-mono text-xs">{ticket.assignedTo}</span></div>}
            {ticket.resolvedAt && <div><span className="text-muted-foreground">Resolved: </span>{new Date(ticket.resolvedAt).toLocaleString()}</div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Description</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{ticket.description ?? "No description"}</p>
            {ticket.resolution && (
              <>
                <Separator className="my-4" />
                <div className="text-sm">
                  <div className="font-medium mb-2">Resolution</div>
                  <p className="text-muted-foreground">{ticket.resolution.notes}</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
