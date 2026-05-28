"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createAgentType } from "@/lib/tenant-actions";

interface ToolOption {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
}

interface AgentCreateFormProps {
  tenantId: string;
  tools: ToolOption[];
}

const MODEL_OPTIONS = [
  { value: "", label: "Tenant default" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (default)" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 (cheap, fast)" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6 (deep reasoning)" },
];

export function AgentCreateForm({ tenantId, tools }: AgentCreateFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    avatarEmoji: "",
    description: "",
    systemPrompt: "",
    modelOverride: "",
    intentKeywords: "",
    intentExamples: "",
    priority: 50,
    shadowMode: true,
    dailySpendCapUsd: "",
  });
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());

  function setField<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleNameChange(value: string) {
    setField("name", value);
    if (!form.slug || form.slug === slugify(form.name)) {
      setField("slug", slugify(value));
    }
  }

  function toggleTool(id: string) {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createAgentType({
        tenantId,
        name: form.name.trim(),
        slug: form.slug.trim(),
        avatarEmoji: form.avatarEmoji.trim() || undefined,
        description: form.description.trim() || undefined,
        systemPrompt: form.systemPrompt,
        modelOverride: form.modelOverride || null,
        intentKeywords: parseList(form.intentKeywords),
        intentExamples: parseList(form.intentExamples),
        priority: form.priority,
        shadowMode: form.shadowMode,
        dailySpendCapUsd: form.dailySpendCapUsd ? Number(form.dailySpendCapUsd) : null,
        toolIds: Array.from(selectedTools),
      });
      if (!result.success) {
        setError(result.error ?? "Failed to create agent");
        return;
      }
      router.push("/agents");
      router.refresh();
    });
  }

  const writeToolSelected = tools.some((t) => selectedTools.has(t.id) && t.category === "write");

  return (
    <Card>
      <CardContent className="p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <fieldset className="space-y-4">
            <legend className="text-sm font-medium">Identity</legend>
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="Sales Forecasting Agent"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="avatarEmoji">Emoji</Label>
                <Input
                  id="avatarEmoji"
                  value={form.avatarEmoji}
                  onChange={(e) => setField("avatarEmoji", e.target.value)}
                  placeholder="📈"
                  className="w-20"
                  maxLength={4}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">Slug</Label>
              <Input
                id="slug"
                value={form.slug}
                onChange={(e) => setField("slug", slugify(e.target.value))}
                placeholder="sales-forecasting"
                pattern="[a-z0-9-]+"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={form.description}
                onChange={(e) => setField("description", e.target.value)}
                placeholder="Forecasts weekly sales based on RFM segments and recent campaigns."
              />
            </div>
          </fieldset>

          <fieldset className="space-y-4 border-t border-border pt-5">
            <legend className="text-sm font-medium">Prompt &amp; model</legend>
            <div className="space-y-2">
              <Label htmlFor="systemPrompt">System prompt</Label>
              <Textarea
                id="systemPrompt"
                value={form.systemPrompt}
                onChange={(e) => setField("systemPrompt", e.target.value)}
                rows={10}
                required
                placeholder="You are a sales forecasting agent for ACME Foods. For each query, output STRICT JSON…"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Be explicit about output shape. If using tools, list them and when to call each.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="modelOverride">Model</Label>
                <select
                  id="modelOverride"
                  value={form.modelOverride}
                  onChange={(e) => setField("modelOverride", e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Input
                  id="priority"
                  type="number"
                  min={0}
                  max={100}
                  value={form.priority}
                  onChange={(e) => setField("priority", Number(e.target.value) || 0)}
                />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-4 border-t border-border pt-5">
            <legend className="text-sm font-medium">Routing (optional)</legend>
            <div className="space-y-2">
              <Label htmlFor="intentKeywords">Intent keywords (comma-separated)</Label>
              <Input
                id="intentKeywords"
                value={form.intentKeywords}
                onChange={(e) => setField("intentKeywords", e.target.value)}
                placeholder="forecast, predict, projection, next week"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="intentExamples">Intent examples (one per line)</Label>
              <Textarea
                id="intentExamples"
                value={form.intentExamples}
                onChange={(e) => setField("intentExamples", e.target.value)}
                rows={3}
                placeholder="How many units will we sell next week?&#10;Forecast tomorrow's milk volume"
              />
            </div>
          </fieldset>

          <fieldset className="space-y-3 border-t border-border pt-5">
            <legend className="text-sm font-medium">Tools ({selectedTools.size} selected)</legend>
            {tools.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No tools registered for this tenant yet. Create tools first, then assign them.
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {tools.map((tool) => {
                  const checked = selectedTools.has(tool.id);
                  return (
                    <li key={tool.id}>
                      <label className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${checked ? "border-primary bg-accent/40" : "border-border hover:bg-accent/20"}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleTool(tool.id)}
                          className="size-4 mt-0.5 rounded border-border"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{tool.name}</span>
                            {tool.category && (
                              <Badge variant={tool.category === "write" ? "destructive" : "secondary"} className="text-[10px]">
                                {tool.category}
                              </Badge>
                            )}
                          </div>
                          {tool.description && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{tool.description}</p>
                          )}
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>

          <fieldset className="space-y-3 border-t border-border pt-5">
            <legend className="text-sm font-medium">Safety</legend>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={form.shadowMode}
                onChange={(e) => setField("shadowMode", e.target.checked)}
                className="size-4 rounded border-border"
              />
              Shadow mode (write tools return dry-run; required for first 14 days if any write tool selected)
            </label>
            {writeToolSelected && !form.shadowMode && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Heads up: you&apos;ve selected at least one write tool but disabled shadow mode. Make sure
                you&apos;ve evaluated this agent&apos;s output before pointing it at production data.
              </div>
            )}
            <div className="space-y-2 max-w-xs">
              <Label htmlFor="dailySpendCapUsd">Daily spend cap (USD, optional)</Label>
              <Input
                id="dailySpendCapUsd"
                type="number"
                min={0}
                step="0.01"
                value={form.dailySpendCapUsd}
                onChange={(e) => setField("dailySpendCapUsd", e.target.value)}
                placeholder="5.00"
              />
              <p className="text-xs text-muted-foreground">
                Leave empty for unlimited. Agent is disabled for the day if exceeded.
              </p>
            </div>
          </fieldset>

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex gap-3 border-t border-border pt-5">
            <Button type="submit" disabled={pending || !form.systemPrompt.trim()}>
              {pending ? "Creating…" : "Create agent"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.push("/agents")} disabled={pending}>
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

function parseList(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
