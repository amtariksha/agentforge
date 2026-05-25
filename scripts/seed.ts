import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { eq, and } from 'drizzle-orm';
import { db, pool } from '../src/shared/db.js';
import {
  tenants, humanAgents, agentTypes, tools, agentTools,
  guardrails, webhookConfigs,
} from '../src/shared/schema/index.js';
import type { TenantSeed } from '../src/shared/types/index.js';
import { encrypt } from '../src/shared/utils/encryption.js';

const SEEDS_DIR = join(import.meta.dirname, '..', 'config', 'seeds');

function resolveEnvValues(obj: unknown): unknown {
  if (typeof obj === 'string') {
    if (obj.startsWith('ENV:')) {
      const envKey = obj.slice(4);
      return process.env[envKey] ?? '';
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvValues);
  }
  if (obj !== null && typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      resolved[key] = resolveEnvValues(value);
    }
    return resolved;
  }
  return obj;
}

async function seedTenant(seed: TenantSeed) {
  const resolvedConfig = resolveEnvValues(seed.tenant.config);

  console.log(`\n--- Seeding tenant: ${seed.tenant.name} ---`);

  // Upsert tenant
  const [existingTenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, seed.tenant.slug))
    .limit(1);

  let tenantId: string;
  if (existingTenant) {
    await db.update(tenants)
      .set({ name: seed.tenant.name, config: resolvedConfig, updatedAt: new Date() })
      .where(eq(tenants.id, existingTenant.id));
    tenantId = existingTenant.id;
    console.log(`  Updated tenant: ${seed.tenant.slug} (${tenantId})`);
  } else {
    const [created] = await db.insert(tenants).values({
      name: seed.tenant.name,
      slug: seed.tenant.slug,
      config: resolvedConfig,
    }).returning();
    tenantId = created.id;
    console.log(`  Created tenant: ${seed.tenant.slug} (${tenantId})`);
  }

  // Seed agent types
  const agentIdMap = new Map<string, string>();
  for (const agent of seed.agents) {
    const [existing] = await db
      .select()
      .from(agentTypes)
      .where(and(eq(agentTypes.tenantId, tenantId), eq(agentTypes.slug, agent.slug)))
      .limit(1);

    const agentRow = {
      name: agent.name,
      avatarEmoji: agent.avatarEmoji,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      intentKeywords: agent.intentKeywords,
      intentExamples: agent.intentExamples,
      priority: agent.priority,
      confidenceThreshold: agent.confidenceThreshold,
      isDefault: agent.isDefault,
      modelOverride: agent.modelOverride ?? null,
      shadowMode: agent.shadowMode ?? false,
      dailySpendCapUsd: agent.dailySpendCapUsd != null ? String(agent.dailySpendCapUsd) : null,
    };
    if (existing) {
      await db.update(agentTypes)
        .set(agentRow)
        .where(eq(agentTypes.id, existing.id));
      agentIdMap.set(agent.slug, existing.id);
      console.log(`  Updated agent type: ${agent.slug}`);
    } else {
      const [created] = await db.insert(agentTypes).values({
        tenantId,
        slug: agent.slug,
        ...agentRow,
      }).returning();
      agentIdMap.set(agent.slug, created.id);
      console.log(`  Created agent type: ${agent.slug}`);
    }
  }

  // Seed tools + agent_tools assignments
  for (const toolEntry of seed.tools) {
    const def = toolEntry.definition;

    const [existing] = await db
      .select()
      .from(tools)
      .where(and(eq(tools.tenantId, tenantId), eq(tools.name, def.name)))
      .limit(1);

    let toolId: string;
    if (existing) {
      await db.update(tools)
        .set({
          description: def.description,
          category: def.category,
          requiresHitl: def.requiresHitl,
          requiresUserConfirm: def.requiresUserConfirm,
          parameters: def.parameters,
          backendMapping: def.backendMapping,
          executionConfig: def.execution,
          isActive: def.isActive,
        })
        .where(eq(tools.id, existing.id));
      toolId = existing.id;
      console.log(`  Updated tool: ${def.name}`);
    } else {
      const [created] = await db.insert(tools).values({
        tenantId,
        name: def.name,
        description: def.description,
        category: def.category,
        requiresHitl: def.requiresHitl,
        requiresUserConfirm: def.requiresUserConfirm,
        parameters: def.parameters,
        backendMapping: def.backendMapping,
        executionConfig: def.execution,
        isActive: def.isActive,
      }).returning();
      toolId = created.id;
      console.log(`  Created tool: ${def.name}`);
    }

    // Assign tool to agents
    for (const agentSlug of toolEntry.assignToAgents) {
      const agentId = agentIdMap.get(agentSlug);
      if (!agentId) {
        console.warn(`  WARNING: Agent slug "${agentSlug}" not found for tool "${def.name}"`);
        continue;
      }
      // Upsert agent_tools (ignore conflict)
      await db.insert(agentTools)
        .values({ agentTypeId: agentId, toolId })
        .onConflictDoNothing();
    }
  }

  // Seed guardrails
  for (const gr of seed.guardrails) {
    const [existing] = await db
      .select()
      .from(guardrails)
      .where(and(eq(guardrails.tenantId, tenantId), eq(guardrails.name, gr.name)))
      .limit(1);

    if (existing) {
      await db.update(guardrails)
        .set({
          ruleType: gr.ruleType,
          config: gr.config,
          action: gr.action,
          triggerResponse: gr.triggerResponse ?? null,
          appliesTo: gr.appliesTo,
          priority: gr.priority,
          isActive: gr.isActive,
        })
        .where(eq(guardrails.id, existing.id));
      console.log(`  Updated guardrail: ${gr.name}`);
    } else {
      await db.insert(guardrails).values({
        tenantId,
        name: gr.name,
        ruleType: gr.ruleType,
        config: gr.config,
        action: gr.action,
        triggerResponse: gr.triggerResponse ?? null,
        appliesTo: gr.appliesTo,
        priority: gr.priority,
        isActive: gr.isActive,
      });
      console.log(`  Created guardrail: ${gr.name}`);
    }
  }

  // Seed human agents
  for (const ha of seed.humanAgents) {
    const [existing] = await db
      .select()
      .from(humanAgents)
      .where(and(eq(humanAgents.tenantId, tenantId), eq(humanAgents.email, ha.email)))
      .limit(1);

    if (existing) {
      console.log(`  Skipped human agent (exists): ${ha.email}`);
    } else {
      const passwordHash = await bcrypt.hash(ha.password, 10);
      await db.insert(humanAgents).values({
        tenantId,
        name: ha.name,
        email: ha.email,
        passwordHash,
        role: ha.role,
      });
      console.log(`  Created human agent: ${ha.email} (${ha.role})`);
    }
  }

  // Seed webhook configs
  for (const wh of seed.webhookConfigs) {
    const [existing] = await db
      .select()
      .from(webhookConfigs)
      .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.url, wh.url)))
      .limit(1);

    if (!existing) {
      await db.insert(webhookConfigs).values({
        tenantId,
        url: wh.url,
        events: wh.events,
      });
      console.log(`  Created webhook config: ${wh.url}`);
    }
  }

  console.log(`  Done: ${seed.tenant.name}`);
}

async function main() {
  console.log('=== AgentForge Seed Runner ===\n');

  const files = readdirSync(SEEDS_DIR).filter(f => f.endsWith('.seed.json'));

  if (files.length === 0) {
    console.log('No seed files found in', SEEDS_DIR);
    return;
  }

  console.log(`Found ${files.length} seed file(s): ${files.join(', ')}`);

  for (const file of files) {
    const content = readFileSync(join(SEEDS_DIR, file), 'utf-8');
    const seed = JSON.parse(content) as TenantSeed;
    await seedTenant(seed);
  }

  console.log('\n=== Seeding complete ===');
  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
