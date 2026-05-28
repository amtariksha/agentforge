import { cookies } from "next/headers";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

async function getAuthHeaders(): Promise<Record<string, string>> {
  const cookieStore = await cookies();
  const headers: Record<string, string> = {};
  const token = cookieStore.get("af_token")?.value;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Send the super-admin's active-tenant override; the server ignores this
  // for non-super-admin tokens (enforced in src/shared/middleware/auth.ts).
  const activeTenant = cookieStore.get("af_active_tenant_id")?.value;
  if (activeTenant) headers["X-Active-Tenant-Id"] = activeTenant;
  return headers;
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const authHeaders = await getAuthHeaders();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders,
    ...(options.headers as Record<string, string>),
  };

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`API ${response.status}: ${errorBody}`);
  }

  return response.json() as Promise<T>;
}

export async function apiPost<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  return api<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function apiPut<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  return api<T>(path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  return api<T>(path, { method: "DELETE" });
}
