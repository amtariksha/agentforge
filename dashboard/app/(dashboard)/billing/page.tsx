import { api } from "@/lib/api";
import { isSuperAdmin } from "@/lib/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  issueInvoice, regenerateInvoicePdf, pauseWallet, resumeWallet, runRollup, adjustWallet, markNotificationRead,
} from "@/lib/billing-actions";

interface Wallet {
  balanceUsd: string;
  billingMode: string;
  marginPct: string;
  monthlyBudgetUsd: string | null;
  lowBalanceThresholdUsd: string;
  isPaused: boolean;
  pausedReason: string | null;
  currency: string;
}
interface AgentRollup { slug: string | null; calls: number; costUsd: string }
interface Period {
  periodStart: string; periodEnd: string; status: string;
  totalCostUsd: string; llmCalls: number; unpricedRows: number; byAgent: AgentRollup[] | null;
}
interface LedgerEntry {
  id: string; type: string; amountUsd: string; balanceAfterUsd: string;
  reference: string; description: string | null; createdAt: string;
}
interface Invoice {
  id: string; invoiceNumber: string; periodStart: string; periodEnd: string;
  subtotalUsd: string; marginUsd: string; totalUsd: string; status: string; pdfPath: string | null; currency: string;
}
interface Notification {
  id: string; type: string; severity: string; title: string; body: string | null; readAt: string | null; createdAt: string;
}

const usd = (v: string | number | null | undefined) => `$${Number(v ?? 0).toFixed(2)}`;
const fmtDate = (s: string) => new Date(s).toISOString().slice(0, 10);

export default async function BillingPage() {
  const superAdmin = await isSuperAdmin();

  let summary: { wallet: Wallet | null; currentPeriod: Period | null } | null = null;
  let ledger: { transactions: LedgerEntry[]; total: number } | null = null;
  let invoiceList: { invoices: Invoice[] } | null = null;
  let notifs: { notifications: Notification[]; unreadCount: number } | null = null;

  try {
    [summary, ledger, invoiceList, notifs] = await Promise.all([
      api<{ wallet: Wallet | null; currentPeriod: Period | null }>("/admin/billing/summary"),
      api<{ transactions: LedgerEntry[]; total: number }>("/admin/billing/ledger?limit=20"),
      api<{ invoices: Invoice[] }>("/admin/billing/invoices?limit=20"),
      api<{ notifications: Notification[]; unreadCount: number }>("/admin/notifications?limit=20"),
    ]);
  } catch (err) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="mt-4 text-red-600">Failed to load billing data: {String(err)}</p>
      </div>
    );
  }

  const wallet = summary?.wallet ?? null;
  const period = summary?.currentPeriod ?? null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Billing</h1>
        {superAdmin && (
          <form action={runRollup}>
            <Button type="submit" variant="outline" size="sm">Run rollup now</Button>
          </form>
        )}
      </div>

      {/* Wallet + current period */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Wallet</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {wallet ? (
              <>
                <div className="flex justify-between"><span>Balance</span><span className="font-mono">{usd(wallet.balanceUsd)} {wallet.currency}</span></div>
                <div className="flex justify-between"><span>Mode</span><Badge variant="secondary">{wallet.billingMode}</Badge></div>
                <div className="flex justify-between"><span>Margin</span><span>{Number(wallet.marginPct).toFixed(2)}%</span></div>
                <div className="flex justify-between"><span>Monthly USD budget</span><span>{wallet.monthlyBudgetUsd ? usd(wallet.monthlyBudgetUsd) : "—"}</span></div>
                <div className="flex justify-between">
                  <span>Status</span>
                  {wallet.isPaused
                    ? <Badge variant="destructive">Paused ({wallet.pausedReason})</Badge>
                    : <Badge>Active</Badge>}
                </div>
                {superAdmin && (
                  <div className="flex gap-2 pt-2">
                    {wallet.isPaused
                      ? <form action={resumeWallet}><Button type="submit" size="sm" variant="outline">Resume</Button></form>
                      : <form action={pauseWallet}><Button type="submit" size="sm" variant="outline">Pause</Button></form>}
                  </div>
                )}
                {superAdmin && (
                  <form action={adjustWallet} className="flex flex-wrap items-end gap-2 pt-3 border-t mt-3">
                    <select name="type" className="border rounded px-2 py-1 text-sm">
                      <option value="credit_manual">Credit</option>
                      <option value="debit_manual">Debit</option>
                      <option value="credit_bonus">Bonus</option>
                      <option value="refund">Refund</option>
                    </select>
                    <input name="amountUsd" type="number" step="0.01" min="0" placeholder="USD" className="border rounded px-2 py-1 text-sm w-24" required />
                    <input name="reason" type="text" placeholder="reason" className="border rounded px-2 py-1 text-sm w-32" />
                    <Button type="submit" size="sm">Adjust</Button>
                  </form>
                )}
              </>
            ) : <p className="text-muted-foreground">No wallet yet.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Current period</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {period ? (
              <>
                <div className="flex justify-between"><span>Period</span><span>{fmtDate(period.periodStart)} → {fmtDate(period.periodEnd)}</span></div>
                <div className="flex justify-between"><span>Status</span><Badge variant="secondary">{period.status}</Badge></div>
                <div className="flex justify-between"><span>Cost (raw)</span><span className="font-mono">{usd(period.totalCostUsd)}</span></div>
                <div className="flex justify-between"><span>LLM calls</span><span>{period.llmCalls}</span></div>
                {period.unpricedRows > 0 && (
                  <div className="flex justify-between text-amber-600"><span>Unpriced records</span><span>{period.unpricedRows}</span></div>
                )}
                {period.byAgent && period.byAgent.length > 0 && (
                  <div className="pt-2 border-t mt-2">
                    <p className="text-muted-foreground mb-1">By agent</p>
                    {period.byAgent.map((a) => (
                      <div key={a.slug ?? "none"} className="flex justify-between">
                        <span>{a.slug ?? "(unattributed)"}</span>
                        <span className="font-mono">{usd(a.costUsd)} · {a.calls} calls</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : <p className="text-muted-foreground">No usage yet this month.</p>}
          </CardContent>
        </Card>
      </div>

      {/* Invoices */}
      <Card>
        <CardHeader><CardTitle>Invoices</CardTitle></CardHeader>
        <CardContent>
          {invoiceList && invoiceList.invoices.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead><TableHead>Period</TableHead><TableHead>Total</TableHead>
                  <TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoiceList.invoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-mono text-xs">{inv.invoiceNumber}</TableCell>
                    <TableCell>{fmtDate(inv.periodStart)}</TableCell>
                    <TableCell className="font-mono">{usd(inv.totalUsd)}</TableCell>
                    <TableCell><Badge variant="secondary">{inv.status}</Badge></TableCell>
                    <TableCell className="text-right space-x-2">
                      {inv.pdfPath && <a href={`/api/billing/invoices/${inv.id}/pdf`} target="_blank" className="text-blue-600 underline text-sm">PDF</a>}
                      {superAdmin && inv.status === "draft" && (
                        <form action={issueInvoice.bind(null, inv.id)} className="inline">
                          <Button type="submit" size="sm" variant="outline">Issue</Button>
                        </form>
                      )}
                      {superAdmin && !inv.pdfPath && (
                        <form action={regenerateInvoicePdf.bind(null, inv.id)} className="inline">
                          <Button type="submit" size="sm" variant="ghost">Regen PDF</Button>
                        </form>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <p className="text-muted-foreground text-sm">No invoices yet.</p>}
        </CardContent>
      </Card>

      {/* Ledger */}
      <Card>
        <CardHeader><CardTitle>Ledger {ledger ? `(${ledger.total})` : ""}</CardTitle></CardHeader>
        <CardContent>
          {ledger && ledger.transactions.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Amount</TableHead>
                  <TableHead>Balance</TableHead><TableHead>Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.transactions.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs">{fmtDate(e.createdAt)}</TableCell>
                    <TableCell><Badge variant="outline">{e.type}</Badge></TableCell>
                    <TableCell className={`font-mono ${Number(e.amountUsd) < 0 ? "text-red-600" : "text-green-600"}`}>{usd(e.amountUsd)}</TableCell>
                    <TableCell className="font-mono">{usd(e.balanceAfterUsd)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{e.description ?? e.reference}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <p className="text-muted-foreground text-sm">No ledger entries yet.</p>}
        </CardContent>
      </Card>

      {/* Notifications */}
      <Card>
        <CardHeader><CardTitle>Notifications {notifs && notifs.unreadCount > 0 ? `(${notifs.unreadCount} unread)` : ""}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {notifs && notifs.notifications.length > 0 ? notifs.notifications.map((n) => (
            <div key={n.id} className={`flex items-start justify-between border-b pb-2 ${n.readAt ? "opacity-60" : ""}`}>
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant={n.severity === "critical" ? "destructive" : n.severity === "warning" ? "secondary" : "outline"}>{n.severity}</Badge>
                  <span className="text-sm font-medium">{n.title}</span>
                </div>
                {n.body && <p className="text-xs text-muted-foreground mt-0.5">{n.body}</p>}
              </div>
              {!n.readAt && (
                <form action={markNotificationRead.bind(null, n.id)}>
                  <Button type="submit" size="sm" variant="ghost">Mark read</Button>
                </form>
              )}
            </div>
          )) : <p className="text-muted-foreground text-sm">No notifications.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
