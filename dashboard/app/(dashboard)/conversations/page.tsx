import { api } from "@/lib/api";
import { cookies } from "next/headers";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Conversation {
  id: string;
  channel: string;
  status: string;
  currentAgentType: string | null;
  messageCount: number | null;
  confidenceAvg: number | null;
  lastMessageAt: string | null;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

export default async function ConversationsPage() {
  const tenantId = await getTenantId();
  let conversations: Conversation[] = [];

  if (tenantId) {
    try {
      const data = await api<{ conversations: Conversation[] }>(
        `/admin/conversations?tenantId=${tenantId}&limit=50`,
      );
      conversations = data.conversations;
    } catch { /* API may not be running */ }
  }

  const statusColor: Record<string, string> = {
    active: "default",
    handoff: "destructive",
    closed: "secondary",
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Conversations</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Messages</TableHead>
                <TableHead className="text-right">Confidence</TableHead>
                <TableHead>Last Activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conversations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No conversations yet
                  </TableCell>
                </TableRow>
              ) : (
                conversations.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/conversations/${c.id}`} className="font-mono text-xs hover:underline">
                        {c.channel}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusColor[c.status] as "default" | "destructive" | "secondary" ?? "default"}>
                        {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{c.currentAgentType ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{c.messageCount ?? 0}</TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {c.confidenceAvg ? `${(c.confidenceAvg * 100).toFixed(0)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : "—"}
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
