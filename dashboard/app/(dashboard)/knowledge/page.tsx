import { api } from "@/lib/api";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface KBDocument {
  id: string;
  filename: string;
  fileType: string;
  chunkCount: number | null;
  status: string;
  createdAt: string;
}

async function getTenantId() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("af_user")?.value;
  if (!raw) return null;
  try { return (JSON.parse(raw) as { tenantId?: string }).tenantId ?? null; } catch { return null; }
}

export default async function KnowledgePage() {
  const tenantId = await getTenantId();
  let documents: KBDocument[] = [];

  if (tenantId) {
    try { documents = await api<KBDocument[]>(`/admin/knowledge/${tenantId}/documents`); } catch { /* */ }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-medium tracking-tight">Knowledge Base</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Filename</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Chunks</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Uploaded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No documents uploaded</TableCell></TableRow>
              ) : (
                documents.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell className="font-medium text-sm">{doc.filename}</TableCell>
                    <TableCell className="font-mono text-xs">{doc.fileType}</TableCell>
                    <TableCell className="text-right font-mono">{doc.chunkCount ?? 0}</TableCell>
                    <TableCell><Badge variant={doc.status === "ready" ? "default" : "secondary"}>{doc.status}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(doc.createdAt).toLocaleDateString()}</TableCell>
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
