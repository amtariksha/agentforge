import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Message {
  id: string;
  senderType: string;
  content: { text?: string; contentType?: string };
  createdAt: string;
}

interface ConversationDetail {
  id: string;
  channel: string;
  status: string;
  currentAgentType: string | null;
  messageCount: number | null;
  user?: { displayName: string | null; platformUserId: string; platform: string };
  messages: Message[];
}

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let conversation: ConversationDetail | null = null;

  try {
    conversation = await api<ConversationDetail>(`/admin/conversations/${id}`);
  } catch { /* API may not be running */ }

  if (!conversation) {
    return <div className="text-muted-foreground">Conversation not found</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-medium tracking-tight">Conversation</h1>
        <Badge>{conversation.status}</Badge>
        <Badge variant="secondary">{conversation.channel}</Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* User info sidebar */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">User</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Name: </span>
              {conversation.user?.displayName ?? "Unknown"}
            </div>
            <div>
              <span className="text-muted-foreground">ID: </span>
              <span className="font-mono text-xs">{conversation.user?.platformUserId}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Platform: </span>
              {conversation.user?.platform}
            </div>
            <div>
              <span className="text-muted-foreground">Agent: </span>
              {conversation.currentAgentType ?? "default"}
            </div>
            <div>
              <span className="text-muted-foreground">Messages: </span>
              {conversation.messageCount}
            </div>
          </CardContent>
        </Card>

        {/* Messages */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Messages</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[500px] pr-4">
              <div className="space-y-3">
                {conversation.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.senderType === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                        msg.senderType === "user"
                          ? "bg-primary text-primary-foreground"
                          : msg.senderType === "operator"
                            ? "bg-chart-1/20 text-foreground"
                            : "bg-muted text-foreground"
                      }`}
                    >
                      <div className="mb-1 font-mono text-[10px] opacity-60">
                        {msg.senderType} · {new Date(msg.createdAt).toLocaleTimeString()}
                      </div>
                      {msg.content.text ?? "[media]"}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
