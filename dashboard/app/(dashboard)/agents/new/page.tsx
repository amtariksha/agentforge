import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { getActiveTenantId, getSessionUser } from "@/lib/tenant";
import { AgentCreateForm } from "@/components/agent-create-form";

interface ToolOption {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
}

export default async function NewAgentPage() {
  const user = await getSessionUser();
  // Tenant admins and super-admins can create agents (super-admin via the switcher).
  if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
    redirect("/agents");
  }

  const tenantId = await getActiveTenantId();
  if (!tenantId) redirect("/");

  let tools: ToolOption[] = [];
  try {
    tools = await api<ToolOption[]>(`/admin/tenants/${tenantId}/tools`);
  } catch {
    /* empty */
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Create Agent Type</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Define a new agent for this tenant. System prompt is the contract — pick tools the
          agent is allowed to call. Start in shadow mode for any agent with write tools.
        </p>
      </div>
      <AgentCreateForm tenantId={tenantId} tools={tools} />
    </div>
  );
}
