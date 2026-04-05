import { eq, and } from 'drizzle-orm';
import { db } from '../shared/db.js';
import { users } from '../shared/schema/index.js';
import { redis } from '../shared/redis.js';
import { createChildLogger } from '../shared/utils/logger.js';
import type { TenantConfig } from '../shared/types/index.js';

const log = createChildLogger({ module: 'user-identity' });

const OTP_KEY_PREFIX = 'otp:';
const OTP_SESSION_PREFIX = 'otp_session:';
const OTP_ATTEMPTS_PREFIX = 'otp_attempts:';
const OTP_COOLDOWN_PREFIX = 'otp_cooldown:';

const OTP_EXPIRY_SECONDS = 300; // 5 minutes
const OTP_SESSION_TTL = 3600; // 60 minutes authenticated session
const MAX_OTP_ATTEMPTS = 3;
const OTP_COOLDOWN_SECONDS = 60;

/**
 * User Resolution Flow:
 * 1. Check local DB by platform_user_id + platform
 * 2. If not found, call tenant backend's user lookup endpoint
 * 3. If found in backend, sync to local DB
 * 4. If not found anywhere, create as new user
 */
export async function resolveUserIdentity(
  tenantId: string,
  platformUserId: string,
  platform: string,
  tenantConfig: TenantConfig,
): Promise<{
  userId: string;
  isNew: boolean;
  backendProfile?: Record<string, unknown>;
}> {
  // Check local DB
  const [existing] = await db
    .select()
    .from(users)
    .where(and(
      eq(users.tenantId, tenantId),
      eq(users.platformUserId, platformUserId),
      eq(users.platform, platform),
    ))
    .limit(1);

  if (existing) {
    return { userId: existing.id, isNew: false, backendProfile: existing.profileData as Record<string, unknown> | undefined };
  }

  // Try tenant backend lookup
  const backendProfile = await lookupFromBackend(platformUserId, tenantConfig);

  if (backendProfile) {
    const [created] = await db.insert(users).values({
      tenantId,
      platformUserId,
      platform,
      backendUserId: backendProfile['id'] as string | undefined,
      displayName: backendProfile['name'] as string | undefined,
      profileData: backendProfile,
    }).returning();

    log.info({ userId: created.id, platform }, 'User synced from backend');
    return { userId: created.id, isNew: false, backendProfile };
  }

  // New user
  const [created] = await db.insert(users).values({
    tenantId,
    platformUserId,
    platform,
  }).returning();

  log.info({ userId: created.id, platform }, 'New user created');
  return { userId: created.id, isNew: true };
}

async function lookupFromBackend(
  platformUserId: string,
  config: TenantConfig,
): Promise<Record<string, unknown> | null> {
  const endpoint = config.backend.userLookupEndpoint;
  const baseUrl = config.backend.baseUrl;

  if (!endpoint || !baseUrl) return null;

  try {
    const url = `${baseUrl}${endpoint}?phone=${encodeURIComponent(platformUserId)}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Add auth
    if (config.backend.authType === 'api_key' && config.backend.authCredentials['api_key']) {
      headers['X-Agent-Key'] = config.backend.authCredentials['api_key'];
    }

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;

    const data = await response.json() as { success?: boolean; data?: Record<string, unknown>; found?: boolean };
    if (data.found === false || data.success === false) return null;

    return data.data ?? data as Record<string, unknown>;
  } catch (err) {
    log.debug({ err }, 'Backend user lookup failed');
    return null;
  }
}

/**
 * Generate and store OTP for user verification.
 */
export async function generateOtp(tenantId: string, phone: string): Promise<{ otp: string; sent: boolean } | { error: string }> {
  // Check cooldown
  const cooldownKey = `${OTP_COOLDOWN_PREFIX}${tenantId}:${phone}`;
  if (await redis.exists(cooldownKey)) {
    return { error: 'Please wait before requesting another OTP' };
  }

  // Check attempt limit
  const attemptsKey = `${OTP_ATTEMPTS_PREFIX}${tenantId}:${phone}`;
  const attempts = parseInt(await redis.get(attemptsKey) ?? '0', 10);
  if (attempts >= MAX_OTP_ATTEMPTS) {
    return { error: 'Maximum OTP attempts exceeded. Please try again later.' };
  }

  // Generate 6-digit OTP
  const otp = String(Math.floor(100000 + Math.random() * 900000));

  // Store OTP
  const otpKey = `${OTP_KEY_PREFIX}${tenantId}:${phone}`;
  await redis.setex(otpKey, OTP_EXPIRY_SECONDS, otp);
  await redis.setex(cooldownKey, OTP_COOLDOWN_SECONDS, '1');

  log.info({ phone: phone.slice(-4) }, 'OTP generated');
  return { otp, sent: true };
}

/**
 * Verify OTP and create authenticated session.
 */
export async function verifyOtp(
  tenantId: string,
  phone: string,
  submittedOtp: string,
): Promise<{ verified: boolean; sessionToken?: string }> {
  const otpKey = `${OTP_KEY_PREFIX}${tenantId}:${phone}`;
  const storedOtp = await redis.get(otpKey);

  const attemptsKey = `${OTP_ATTEMPTS_PREFIX}${tenantId}:${phone}`;

  if (!storedOtp) {
    return { verified: false };
  }

  if (storedOtp !== submittedOtp) {
    await redis.incr(attemptsKey);
    await redis.expire(attemptsKey, OTP_EXPIRY_SECONDS);
    return { verified: false };
  }

  // OTP verified — clean up and create session
  await redis.del(otpKey);
  await redis.del(attemptsKey);

  const sessionToken = `otp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await redis.setex(`${OTP_SESSION_PREFIX}${tenantId}:${phone}`, OTP_SESSION_TTL, sessionToken);

  log.info({ phone: phone.slice(-4) }, 'OTP verified, session created');
  return { verified: true, sessionToken };
}

/**
 * Check if a user has a verified OTP session.
 */
export async function hasVerifiedSession(tenantId: string, phone: string): Promise<boolean> {
  return (await redis.exists(`${OTP_SESSION_PREFIX}${tenantId}:${phone}`)) === 1;
}
