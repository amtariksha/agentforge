import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface QueueItem {
  id: string;
  userId: string;
  channel: string;
  currentAgentType: string | null;
  messageCount: number | null;
  lastMessageAt: string | null;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

export default async function LiveChatPage() {
  const tenantId = await getTenantId();
  let queue: QueueItem[] = [];

  if (tenantId) {
    try { queue = await api<QueueItem[]>(`/admin/live-chat/queue/${tenantId}`); } catch { /* */ }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-medium tracking-tight">Live Chat</h1>
        <Badge variant={queue.length > 0 ? "destructive" : "secondary"}>
          {queue.length} waiting
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Handoff Queue</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Conversation</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Agent Type</TableHead>
                <TableHead className="text-right">Messages</TableHead>
                <TableHead>Waiting Since</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No conversations waiting for handoff
                  </TableCell>
                </TableRow>
              ) : (
                queue.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs">{item.id.slice(0, 8)}</TableCell>
                    <TableCell>{item.channel}</TableCell>
                    <TableCell>{item.currentAgentType ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono">{item.messageCount ?? 0}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.lastMessageAt ? new Date(item.lastMessageAt).toLocaleString() : "—"}
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
