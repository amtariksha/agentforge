import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cookies } from "next/headers";

interface OverviewData {
  conversations: { total: number; active: number; avgMessages: number };
  tickets: { total: number; open: number; resolved: number; slaBreached: number };
}

interface CostData {
  totals: {
    totalCost: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    cacheHitRate: string;
  };
}

async function getTenantId() {
  const cookieStore = await cookies();
  const userRaw = cookieStore.get("af_user")?.value;
  if (!userRaw) return null;
  try {
    return (JSON.parse(userRaw) as { tenantId?: string }).tenantId ?? null;
  } catch {
    return null;
  }
}

export default async function OverviewPage() {
  const tenantId = await getTenantId();

  let overview: OverviewData | null = null;
  let costs: CostData | null = null;

  if (tenantId) {
    try {
      [overview, costs] = await Promise.all([
        api<OverviewData>(`/admin/analytics/${tenantId}/overview?days=30`),
        api<CostData>(`/admin/analytics/${tenantId}/costs?days=30`),
      ]);
    } catch {
      /* API may not be running */
    }
  }

  const cards = [
    { title: "Conversations", value: overview?.conversations.total ?? 0, sub: `${overview?.conversations.active ?? 0} active` },
    { title: "Tickets", value: overview?.tickets.total ?? 0, sub: `${overview?.tickets.open ?? 0} open` },
    { title: "SLA Breached", value: overview?.tickets.slaBreached ?? 0, sub: "last 30 days" },
    { title: "LLM Cost", value: `$${parseFloat(costs?.totals.totalCost ?? "0").toFixed(2)}`, sub: `Cache hit: ${costs?.totals.cacheHitRate ?? "0%"}` },
    { title: "Input Tokens", value: (costs?.totals.totalInputTokens ?? 0).toLocaleString(), sub: "last 30 days" },
    { title: "Output Tokens", value: (costs?.totals.totalOutputTokens ?? 0).toLocaleString(), sub: "last 30 days" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-normal text-muted-foreground">
                {card.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tracking-tight">
                {card.value}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{card.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
