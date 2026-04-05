import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

interface CostByModel {
  model: string;
  cost: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

interface ConvByChannel { channel: string; count: number }
interface ConvByAgent { agentType: string | null; count: number }
interface EscalationStats { total: number; autoEscalation: number; userRequest: number; guardrailFlag: number }

export default async function AnalyticsPage() {
  const tenantId = await getTenantId();

  type CostResult = { totals: { totalCost: string; cacheHitRate: string }; byModel: CostByModel[] };
  type ConvResult = { byChannel: ConvByChannel[]; byAgentType: ConvByAgent[] };
  type HitlResult = { escalations: EscalationStats };

  let costs: CostResult | null = null;
  let convs: ConvResult | null = null;
  let hitl: HitlResult | null = null;

  if (tenantId) {
    try {
      const results = await Promise.all([
        api<CostResult>(`/admin/analytics/${tenantId}/costs?days=30`),
        api<ConvResult>(`/admin/analytics/${tenantId}/conversations?days=30`),
        api<HitlResult>(`/admin/analytics/${tenantId}/hitl?days=30`),
      ]);
      costs = results[0];
      convs = results[1];
      hitl = results[2];
    } catch { /* */ }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Analytics</h1>
      <Tabs defaultValue="costs">
        <TabsList>
          <TabsTrigger value="costs">Costs</TabsTrigger>
          <TabsTrigger value="conversations">Conversations</TabsTrigger>
          <TabsTrigger value="hitl">HITL</TabsTrigger>
        </TabsList>

        <TabsContent value="costs" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total Cost (30d)</CardTitle></CardHeader>
              <CardContent><div className="text-2xl font-semibold">${parseFloat(costs?.totals.totalCost ?? "0").toFixed(2)}</div></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Cache Hit Rate</CardTitle></CardHeader>
              <CardContent><div className="text-2xl font-semibold">{costs?.totals.cacheHitRate ?? "0%"}</div></CardContent>
            </Card>
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Input Tokens</TableHead>
                    <TableHead className="text-right">Output Tokens</TableHead>
                    <TableHead className="text-right">Cached</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(costs?.byModel ?? []).map((m) => (
                    <TableRow key={m.model}>
                      <TableCell className="font-mono text-xs">{m.model}</TableCell>
                      <TableCell className="text-right font-mono">{m.calls}</TableCell>
                      <TableCell className="text-right font-mono">{m.inputTokens.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono">{m.outputTokens.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono">{m.cachedTokens.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono">${parseFloat(m.cost).toFixed(4)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="conversations" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm">By Channel</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {(convs?.byChannel ?? []).map((c) => (
                  <div key={c.channel} className="flex justify-between text-sm">
                    <span>{c.channel}</span><span className="font-mono">{c.count}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">By Agent Type</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {(convs?.byAgentType ?? []).map((a) => (
                  <div key={a.agentType ?? "default"} className="flex justify-between text-sm">
                    <span>{a.agentType ?? "default"}</span><span className="font-mono">{a.count}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="hitl" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Total Escalations", value: hitl?.escalations.total ?? 0 },
              { label: "Auto Escalation", value: hitl?.escalations.autoEscalation ?? 0 },
              { label: "User Request", value: hitl?.escalations.userRequest ?? 0 },
              { label: "Guardrail Flag", value: hitl?.escalations.guardrailFlag ?? 0 },
            ].map((stat) => (
              <Card key={stat.label}>
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{stat.label}</CardTitle></CardHeader>
                <CardContent><div className="text-2xl font-semibold">{stat.value}</div></CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
