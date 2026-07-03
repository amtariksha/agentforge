"use server";

import { apiPost } from "@/lib/api";
import { revalidatePath } from "next/cache";

export async function issueInvoice(id: string): Promise<void> {
  await apiPost(`/admin/billing/invoices/${id}/issue`, {});
  revalidatePath("/billing");
}

export async function regenerateInvoicePdf(id: string): Promise<void> {
  await apiPost(`/admin/billing/invoices/${id}/regenerate-pdf`, {});
  revalidatePath("/billing");
}

export async function pauseWallet(): Promise<void> {
  await apiPost("/admin/billing/wallet/pause", {});
  revalidatePath("/billing");
}

export async function resumeWallet(): Promise<void> {
  await apiPost("/admin/billing/wallet/resume", {});
  revalidatePath("/billing");
}

export async function runRollup(): Promise<void> {
  await apiPost("/admin/billing/rollup/run", {});
  revalidatePath("/billing");
}

export async function adjustWallet(formData: FormData): Promise<void> {
  const type = String(formData.get("type"));
  const amountUsd = Number(formData.get("amountUsd"));
  const reason = String(formData.get("reason") || "Manual adjustment");
  // A per-submit idempotency key so an accidental double-submit is a no-op.
  const idempotencyKey = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await apiPost("/admin/billing/wallet/adjust", { type, amountUsd, reason, idempotencyKey });
  revalidatePath("/billing");
}

export async function markNotificationRead(id: string): Promise<void> {
  await apiPost(`/admin/notifications/${id}/read`, {});
  revalidatePath("/billing");
}
