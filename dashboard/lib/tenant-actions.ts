"use server";

import { api, apiPost } from "@/lib/api";
import { revalidatePath } from "next/cache";

interface CreateTenantArgs {
  name: string;
  slug: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  seedStarterAgent: boolean;
}

interface CreateTenantResult {
  success: boolean;
  tenantId?: string;
  error?: string;
}

/**
 * Two-step tenant creation:
 *   1. POST /admin/tenants — creates the tenant row with a minimal config.
 *   2. POST /admin/tenants/:id/bootstrap — seeds admin user + starter agent.
 * Both endpoints are super-admin-only on the backend.
 */
export async function createTenant(args: CreateTenantArgs): Promise<CreateTenantResult> {
  try {
    // Step 1: create tenant with a placeholder config (operator can edit later).
    const tenant = await apiPost<{ id: string }>("/admin/tenants", {
      name: args.name,
      slug: args.slug,
      config: {
        persona: {
          name: args.name,
          avatar: { name: args.name, emoji: "🤖" },
          personalityTraits: [],
          tone: "balanced",
          definition: `Default assistant for ${args.name}.`,
          guidelines: "Be helpful, accurate, and respectful.",
          introduction: "",
          languagePrimary: "en",
          languageSupported: ["en"],
          responseStyle: {
            maxLength: "medium",
            useEmojis: false,
            useMarkdown: false,
            formattingRules: "",
          },
          fallbackMessage: "Let me connect you with our team.",
          systemPromptAdditions: "",
        },
        channels: {},
        backend: {
          baseUrl: "",
          authType: "api_key",
          authCredentials: {},
          userLookupEndpoint: "",
          rateLimit: { requestsPerMinute: 60, requestsPerHour: 1000 },
        },
        ai: {
          primaryModel: "claude-sonnet-4-6",
          premiumModel: "claude-opus-4-6",
          routingModel: "claude-haiku-4-5",
          maxTokensPerResponse: 500,
          temperature: 0.7,
          monthlyTokenBudget: 1000000,
          enableThinking: false,
          promptCacheEnabled: true,
        },
        context: {
          systemTokenBudget: 2000,
          shortTermBudget: 3000,
          longTermBudget: 2000,
          memoryIndexBudget: 300,
          summarizationThreshold: 6000,
          maxConversationTurns: 50,
        },
        hitl: {
          autoEscalateConfidenceBelow: 0.3,
          autoEscalateTopics: [],
          requireApprovalForActions: [],
          maxAutoActionsPerSession: 10,
          escalationChannels: ["dashboard"],
        },
        orchestrator: {
          enableAutoRouting: true,
          confidenceThreshold: 0.4,
          maxAgentSwitchesPerSession: 3,
          handoffOnLowConfidence: true,
          handoffOnNegativeSentiment: true,
          handoffOnUserRequest: true,
          handoffKeywords: ["human", "manager", "call me", "talk to person"],
        },
        agents: [],
      },
    });

    // Step 2: bootstrap admin user + starter agent.
    await apiPost(`/admin/tenants/${tenant.id}/bootstrap`, {
      adminName: args.adminName,
      adminEmail: args.adminEmail,
      adminPassword: args.adminPassword,
      seedStarterAgent: args.seedStarterAgent,
    });

    revalidatePath("/tenants");
    return { success: true, tenantId: tenant.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function getTenantDetail(id: string) {
  try {
    return await api<Record<string, unknown>>(`/admin/tenants/${id}`);
  } catch {
    return null;
  }
}

interface CreateAgentArgs {
  tenantId: string;
  name: string;
  slug: string;
  avatarEmoji?: string;
  description?: string;
  systemPrompt: string;
  modelOverride?: string | null;
  intentKeywords: string[];
  intentExamples: string[];
  priority: number;
  shadowMode: boolean;
  dailySpendCapUsd?: number | null;
  toolIds: string[];
}

export async function createAgentType(args: CreateAgentArgs): Promise<{ success: boolean; agentId?: string; error?: string }> {
  try {
    const created = await apiPost<{ id: string }>(`/admin/tenants/${args.tenantId}/agents`, {
      name: args.name,
      slug: args.slug,
      avatarEmoji: args.avatarEmoji || undefined,
      description: args.description || undefined,
      systemPrompt: args.systemPrompt,
      modelOverride: args.modelOverride || null,
      intentKeywords: args.intentKeywords,
      intentExamples: args.intentExamples,
      priority: args.priority,
      shadowMode: args.shadowMode,
      dailySpendCapUsd: args.dailySpendCapUsd ?? null,
    });

    if (args.toolIds.length > 0) {
      await apiPost(`/admin/tenants/${args.tenantId}/agents/${created.id}/tools`, {
        toolIds: args.toolIds,
      });
    }

    revalidatePath("/agents");
    return { success: true, agentId: created.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
