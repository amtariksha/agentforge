import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get("af_token")?.value;
  const userRaw = cookieStore.get("af_user")?.value;

  if (!token) redirect("/login");

  let user: { name?: string; tenantId?: string } = {};
  try {
    user = userRaw ? JSON.parse(userRaw) : {};
  } catch {
    /* ignore */
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header userName={user.name} tenantName={user.tenantId} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
