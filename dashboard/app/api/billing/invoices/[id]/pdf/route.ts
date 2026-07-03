import { cookies } from "next/headers";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

/**
 * Auth proxy for invoice PDFs. The backend endpoint requires a Bearer token
 * that lives in an httpOnly cookie on the dashboard origin (not the API origin),
 * so a direct browser link can't carry it — this handler forwards the request
 * server-side with the auth + active-tenant headers and streams the PDF back.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const cookieStore = await cookies();
  const headers: Record<string, string> = {};
  const token = cookieStore.get("af_token")?.value;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const activeTenant = cookieStore.get("af_active_tenant_id")?.value;
  if (activeTenant) headers["X-Active-Tenant-Id"] = activeTenant;

  const res = await fetch(`${API_URL}/admin/billing/invoices/${id}/pdf`, { headers, cache: "no-store" });
  if (!res.ok || !res.body) {
    return new Response("Invoice PDF not available", { status: res.status || 502 });
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": res.headers.get("content-disposition") ?? `inline; filename="invoice-${id}.pdf"`,
    },
  });
}
