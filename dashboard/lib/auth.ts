"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

interface LoginResult {
  success: boolean;
  error?: string;
}

interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  tenantId: string;
  status?: string;
}

export async function login(
  email: string,
  password: string,
  tenantId?: string,
): Promise<LoginResult> {
  try {
    const response = await fetch(`${API_URL}/admin/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, tenantId }),
    });

    if (!response.ok) {
      return { success: false, error: "Invalid credentials" };
    }

    const data = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
      agent: AuthUser;
    };

    const cookieStore = await cookies();
    cookieStore.set("af_token", data.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24, // 24 hours
      path: "/",
    });

    cookieStore.set("af_user", JSON.stringify(data.agent), {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24,
      path: "/",
    });

    return { success: true };
  } catch {
    return { success: false, error: "Connection failed" };
  }
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete("af_token");
  cookieStore.delete("af_user");
  redirect("/login");
}

export async function getSession(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const userCookie = cookieStore.get("af_user")?.value;
  if (!userCookie) return null;

  try {
    return JSON.parse(userCookie) as AuthUser;
  } catch {
    return null;
  }
}

export async function requireAuth(): Promise<AuthUser> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
