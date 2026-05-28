import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';

export interface JwtPayload {
  agentId: string;
  /** The user's home tenant — the tenant they were created under. */
  tenantId: string;
  email: string;
  /** 'super_admin' | 'admin' | 'operator' | 'viewer'. */
  role: string;
}

/**
 * Augmented Fastify request with auth context. After authMiddleware runs:
 *   - `auth` is the verified JWT payload
 *   - `activeTenantId` is the effective tenant for this request:
 *     - For super_admin: X-Active-Tenant-Id header if present, else JWT tenantId.
 *     - For everyone else: JWT tenantId. The header is ignored.
 *
 * Routes should use `activeTenantId` to scope DB queries. Use `auth.tenantId`
 * only when you specifically need the user's home tenant (e.g., audit logs).
 */
export type AuthenticatedRequest = FastifyRequest & {
  auth: JwtPayload;
  activeTenantId: string;
};

/** Helper for routes — get the effective tenant for the current request. */
export function getActiveTenantId(request: FastifyRequest): string {
  const r = request as AuthenticatedRequest;
  return r.activeTenantId ?? r.auth?.tenantId;
}

/** True if the authenticated user can act across tenants. */
export function isSuperAdmin(request: FastifyRequest): boolean {
  const r = request as AuthenticatedRequest;
  return r.auth?.role === 'super_admin';
}

export function signToken(payload: JwtPayload, expiresIn?: string): string {
  return jwt.sign({ ...payload }, JWT_SECRET, {
    expiresIn: (expiresIn ?? process.env.JWT_EXPIRES_IN ?? '24h') as jwt.SignOptions['expiresIn'],
  } satisfies jwt.SignOptions);
}

export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload }, JWT_SECRET, {
    expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN ?? '7d') as jwt.SignOptions['expiresIn'],
  } satisfies jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.slice(7);
  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }

  const r = request as AuthenticatedRequest;
  r.auth = payload;

  // Determine the effective tenant for this request. Only super_admin can
  // override their home tenant via the X-Active-Tenant-Id header; everyone
  // else is pinned to their JWT tenantId regardless of what they send.
  const headerOverride =
    payload.role === 'super_admin'
      ? (request.headers['x-active-tenant-id'] as string | undefined)
      : undefined;
  r.activeTenantId = headerOverride && headerOverride.length > 0 ? headerOverride : payload.tenantId;
}

/**
 * Gate a route on one or more roles. `super_admin` is implicitly accepted
 * for any role check (super-admins can do anything an admin can). To restrict
 * to super_admin only, use `requireRole('super_admin')`.
 */
export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = (request as FastifyRequest & { auth: JwtPayload }).auth;
    if (!auth) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    if (auth.role === 'super_admin' || roles.includes(auth.role)) {
      return;
    }
    return reply.status(403).send({ error: 'Insufficient permissions' });
  };
}

/** Stricter helper for super-admin-only routes (tenant management). */
export function requireSuperAdmin() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = (request as FastifyRequest & { auth: JwtPayload }).auth;
    if (!auth) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    if (auth.role !== 'super_admin') {
      return reply.status(403).send({ error: 'Super-admin only' });
    }
  };
}
