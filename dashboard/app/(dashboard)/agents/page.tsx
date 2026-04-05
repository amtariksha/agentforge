import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface AgentType {
  id: string;
  name: string;
  slug: string;
  avatarEmoji: string | null;
  description: string | null;
  priority: number | null;
  confidenceThreshold: number | null;
  isDefault: boolean | null;
  modelOverride: string | null;
  isActive: boolean | null;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

export default async function AgentTypesPage() {
  const tenantId = await getTenantId();
  let agents: AgentType[] = [];

  if (tenantId) {
    try { agents = await api<AgentType[]>(`/admin/tenants/${tenantId}/agents`); } catch { /* */ }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Agent Types</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.length === 0 ? (
          <Card className="col-span-full">
            <CardContent className="py-8 text-center text-muted-foreground">
              No agent types configured
            </CardContent>
          </Card>
        ) : (
          agents.map((agent) => (
            <Card key={agent.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{agent.avatarEmoji ?? "🤖"}</span>
                  <CardTitle className="text-base">{agent.name}</CardTitle>
                  {agent.isDefault && <Badge variant="secondary">Default</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground">{agent.description ?? "No description"}</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="font-mono text-muted-foreground">slug: {agent.slug}</span>
                  <span className="font-mono text-muted-foreground">
                    confidence: {((agent.confidenceThreshold ?? 0.7) * 100).toFixed(0)}%
                  </span>
                  {agent.modelOverride && (
                    <span className="font-mono text-muted-foreground">model: {agent.modelOverride}</span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
