import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface CorrectionRule {
  id: string;
  pattern: string;
  instruction: string;
  isActive: boolean | null;
  usageCount: number | null;
  createdAt: string;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

export default async function CorrectionsPage() {
  const tenantId = await getTenantId();
  let rules: CorrectionRule[] = [];

  if (tenantId) {
    try { rules = await api<CorrectionRule[]>(`/admin/corrections/rules/${tenantId}`); } catch { /* */ }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Correction Rules</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pattern</TableHead>
                <TableHead>Instruction</TableHead>
                <TableHead className="text-right">Uses</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No correction rules</TableCell></TableRow>
              ) : (
                rules.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs max-w-[200px] truncate">{r.pattern}</TableCell>
                    <TableCell className="text-sm max-w-[300px] truncate">{r.instruction}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{r.usageCount ?? 0}</TableCell>
                    <TableCell><Badge variant={r.isActive ? "default" : "secondary"}>{r.isActive ? "Active" : "Inactive"}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleDateString()}</TableCell>
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
