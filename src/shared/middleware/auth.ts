import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';

export interface JwtPayload {
  agentId: string;
  tenantId: string;
  email: string;
  role: string;
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
  try {
    const payload = verifyToken(token);
    (request as FastifyRequest & { auth: JwtPayload }).auth = payload;
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = (request as FastifyRequest & { auth: JwtPayload }).auth;
    if (!auth) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    if (!roles.includes(auth.role)) {
      return reply.status(403).send({ error: 'Insufficient permissions' });
    }
  };
}
