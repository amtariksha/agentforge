import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Guardrail {
  id: string;
  name: string;
  ruleType: string;
  action: string;
  appliesTo: string;
  priority: number | null;
  isActive: boolean | null;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

function GuardrailTable({ guardrails }: { guardrails: Guardrail[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Scope</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {guardrails.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="text-center text-muted-foreground py-8">No guardrails</TableCell>
          </TableRow>
        ) : (
          guardrails.map((g) => (
            <TableRow key={g.id}>
              <TableCell className="font-medium text-sm">{g.name}</TableCell>
              <TableCell><Badge variant="outline">{g.ruleType}</Badge></TableCell>
              <TableCell><Badge variant={g.action === "block" ? "destructive" : "secondary"}>{g.action}</Badge></TableCell>
              <TableCell className="text-sm">{g.appliesTo}</TableCell>
              <TableCell><Badge variant={g.isActive ? "default" : "secondary"}>{g.isActive ? "Active" : "Inactive"}</Badge></TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

export default async function GuardrailsPage() {
  const tenantId = await getTenantId();
  let globalGuardrails: Guardrail[] = [];
  let tenantGuardrails: Guardrail[] = [];

  try { globalGuardrails = await api<Guardrail[]>("/admin/guardrails/global"); } catch { /* */ }
  if (tenantId) {
    try { tenantGuardrails = await api<Guardrail[]>(`/admin/guardrails/${tenantId}`); } catch { /* */ }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Guardrails</h1>
      <Tabs defaultValue="tenant">
        <TabsList>
          <TabsTrigger value="tenant">Tenant ({tenantGuardrails.length})</TabsTrigger>
          <TabsTrigger value="global">Global ({globalGuardrails.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="tenant">
          <Card><CardContent className="p-0"><GuardrailTable guardrails={tenantGuardrails} /></CardContent></Card>
        </TabsContent>
        <TabsContent value="global">
          <Card><CardContent className="p-0"><GuardrailTable guardrails={globalGuardrails} /></CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
