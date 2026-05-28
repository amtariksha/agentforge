"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { createTenant } from "@/lib/tenant-actions";

export function TenantCreateForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    adminName: "",
    adminEmail: "",
    adminPassword: "",
    seedStarterAgent: true,
  });

  function setField<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Auto-derive slug from name if user hasn't typed one
  function handleNameChange(value: string) {
    setField("name", value);
    if (!form.slug || form.slug === slugify(form.name)) {
      setField("slug", slugify(value));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createTenant(form);
      if (!result.success) {
        setError(result.error ?? "Failed to create tenant");
        return;
      }
      router.push(`/tenants/${result.tenantId}`);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          <fieldset className="space-y-4">
            <legend className="text-sm font-medium">Tenant</legend>
            <div className="space-y-2">
              <Label htmlFor="name">Display name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Acme Foods"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">Slug</Label>
              <Input
                id="slug"
                value={form.slug}
                onChange={(e) => setField("slug", slugify(e.target.value))}
                placeholder="acme-foods"
                pattern="[a-z0-9-]+"
                required
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, digits, and hyphens only. Used in URLs and webhook paths.
              </p>
            </div>
          </fieldset>

          <fieldset className="space-y-4 border-t border-border pt-5">
            <legend className="text-sm font-medium">Default admin user</legend>
            <div className="space-y-2">
              <Label htmlFor="adminName">Admin name</Label>
              <Input
                id="adminName"
                value={form.adminName}
                onChange={(e) => setField("adminName", e.target.value)}
                placeholder="Jane Doe"
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="adminEmail">Admin email</Label>
                <Input
                  id="adminEmail"
                  type="email"
                  value={form.adminEmail}
                  onChange={(e) => setField("adminEmail", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="adminPassword">Temporary password</Label>
                <Input
                  id="adminPassword"
                  type="password"
                  value={form.adminPassword}
                  onChange={(e) => setField("adminPassword", e.target.value)}
                  minLength={8}
                  required
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              The admin should rotate this on first login. Min 8 characters.
            </p>
          </fieldset>

          <fieldset className="space-y-3 border-t border-border pt-5">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={form.seedStarterAgent}
                onChange={(e) => setField("seedStarterAgent", e.target.checked)}
                className="size-4 rounded border-border"
              />
              Seed a starter <code className="font-mono text-xs">support</code> agent type
            </label>
          </fieldset>

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex gap-3 border-t border-border pt-5">
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create tenant"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push("/tenants")}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
