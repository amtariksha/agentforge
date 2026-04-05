import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

interface TenantData {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  config: {
    persona?: { name: string; tone: string; definition: string; guidelines: string; languagePrimary: string; languageSupported: string[] };
    ai?: { primaryModel: string; premiumModel: string; routingModel: string; temperature: number; monthlyTokenBudget: number };
    orchestrator?: { enableAutoRouting: boolean; confidenceThreshold: number; handoffKeywords: string[] };
    hitl?: { autoEscalateConfidenceBelow: number; autoEscalateTopics: string[] };
    channels?: { whatsapp?: Record<string, unknown>; telegram?: Record<string, unknown>; web?: Record<string, unknown> };
  };
}

export default async function SettingsPage() {
  const tenantId = await getTenantId();
  let tenant: TenantData | null = null;

  if (tenantId) {
    try { tenant = await api<TenantData>(`/admin/tenants/${tenantId}`); } catch { /* */ }
  }

  if (!tenant) return <div className="text-muted-foreground">Tenant not found</div>;

  const config = tenant.config;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-medium tracking-tight">Settings</h1>
        <Badge variant="outline">{tenant.slug}</Badge>
      </div>

      <Tabs defaultValue="persona">
        <TabsList>
          <TabsTrigger value="persona">Persona</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="orchestrator">Orchestrator</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="hitl">HITL</TabsTrigger>
        </TabsList>

        <TabsContent value="persona">
          <Card>
            <CardHeader><CardTitle className="text-sm">Brand Persona</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div><span className="text-muted-foreground">Name: </span>{config.persona?.name}</div>
              <div><span className="text-muted-foreground">Tone: </span>{config.persona?.tone}</div>
              <div><span className="text-muted-foreground">Primary Language: </span>{config.persona?.languagePrimary}</div>
              <div><span className="text-muted-foreground">Supported: </span>{config.persona?.languageSupported?.join(", ")}</div>
              <Separator />
              <div><span className="text-muted-foreground block mb-1">Definition:</span><p className="text-muted-foreground text-xs">{config.persona?.definition}</p></div>
              <div><span className="text-muted-foreground block mb-1">Guidelines:</span><p className="text-muted-foreground text-xs">{config.persona?.guidelines}</p></div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ai">
          <Card>
            <CardHeader><CardTitle className="text-sm">AI Configuration</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <div><span className="text-muted-foreground">Primary Model: </span><span className="font-mono text-xs">{config.ai?.primaryModel}</span></div>
                <div><span className="text-muted-foreground">Premium Model: </span><span className="font-mono text-xs">{config.ai?.premiumModel}</span></div>
                <div><span className="text-muted-foreground">Routing Model: </span><span className="font-mono text-xs">{config.ai?.routingModel}</span></div>
                <div><span className="text-muted-foreground">Temperature: </span><span className="font-mono">{config.ai?.temperature}</span></div>
                <div><span className="text-muted-foreground">Monthly Budget: </span><span className="font-mono">{(config.ai?.monthlyTokenBudget ?? 0).toLocaleString()} tokens</span></div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orchestrator">
          <Card>
            <CardHeader><CardTitle className="text-sm">Orchestrator</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div><span className="text-muted-foreground">Auto Routing: </span>{config.orchestrator?.enableAutoRouting ? "Enabled" : "Disabled"}</div>
              <div><span className="text-muted-foreground">Confidence Threshold: </span><span className="font-mono">{config.orchestrator?.confidenceThreshold}</span></div>
              <div><span className="text-muted-foreground">Handoff Keywords: </span>{config.orchestrator?.handoffKeywords?.join(", ")}</div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="channels">
          <Card>
            <CardHeader><CardTitle className="text-sm">Channels</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {config.channels?.whatsapp && <Badge>WhatsApp</Badge>}
              {config.channels?.telegram && <Badge variant="secondary">Telegram</Badge>}
              {config.channels?.web && <Badge variant="outline">Web Widget</Badge>}
              {!config.channels?.whatsapp && !config.channels?.telegram && !config.channels?.web && (
                <span className="text-muted-foreground">No channels configured</span>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="hitl">
          <Card>
            <CardHeader><CardTitle className="text-sm">Human-in-the-Loop</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div><span className="text-muted-foreground">Auto-Escalate Below: </span><span className="font-mono">{config.hitl?.autoEscalateConfidenceBelow}</span></div>
              <div><span className="text-muted-foreground">Escalation Topics: </span>{config.hitl?.autoEscalateTopics?.join(", ")}</div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
