import { redirect } from "next/navigation";
import { isSuperAdmin } from "@/lib/tenant";
import { TenantCreateForm } from "@/components/tenant-create-form";

export default async function NewTenantPage() {
  if (!(await isSuperAdmin())) redirect("/");

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Create Tenant</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Sets up a new tenant with a default admin user and a starter
          &quot;support&quot; agent. You can refine the config from the tenant detail page after creation.
        </p>
      </div>
      <TenantCreateForm />
    </div>
  );
}
