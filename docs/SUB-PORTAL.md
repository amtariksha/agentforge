# Tenant Sub-Portal Deployment

A **sub-portal** is the same AgentForge Next.js dashboard deployed under a
tenant's own domain, locked to that tenant. It looks and behaves exactly
like the platform dashboard except:

- No tenant switcher in the header — only their tenant is visible.
- No "Tenants" page in the sidebar (super-admin only).
- The login form forces every authentication request to scope to the
  locked tenant slug. Users from other tenants will get
  `401 Invalid credentials` even with valid credentials elsewhere.
- The sidebar omits the platform-owner menu items.

The backend (chatagent API at `agentforge.amtariksha.com`) is the same in
both modes — sub-portals don't change server logic, they just change which
UI is presented at a given URL.

## When to use this

Use a sub-portal when a tenant wants:
- Their own subdomain (e.g. `agents.swargfood.com`) instead of a shared one.
- White-label feel — no cross-tenant chrome visible to their users.
- A clean "Sign in" page that only their team would land on.

If the tenant is happy logging in at the shared dashboard URL, they don't
need this — the existing dashboard already isolates tenants strictly on
the server side.

## Deployment

### Option A — Vercel (recommended)

1. Import this repo at <https://vercel.com/new> with **Root Directory** =
   `dashboard`.
2. Add environment variables:
   - `API_URL=https://agentforge.amtariksha.com`
   - `NEXT_PUBLIC_TENANT_SLUG_LOCK=<tenant-slug>` (e.g. `swarg-food`)
3. Deploy. You get a `<project>.vercel.app` URL.
4. Map the tenant's domain in Vercel → Project → Settings → Domains
   (e.g. `agents.swargfood.com`). Add the CNAME to the tenant's DNS.

The same backend serves both the platform dashboard and every sub-portal
— no extra infrastructure.

### Option B — Self-host

The tenant can clone the repo and deploy the `dashboard/` directory anywhere
that runs Next.js (Vercel, Cloudflare Pages, Docker on their own infra).
Same two env vars apply. CORS at the backend is permissive (`origin: true`),
so any origin can authenticate as long as it presents valid credentials.

## What the lock changes (code-level)

| File | Behavior under lock |
|---|---|
| `dashboard/app/(dashboard)/layout.tsx` | `getTenantSlugLock()` returns the slug; super-admin checks short-circuit to false; tenant switcher hidden. |
| `dashboard/components/sidebar.tsx` | Items marked `superAdminOnly` (e.g. `/tenants`) are filtered out. |
| `dashboard/app/api/auth/login/route.ts` | Always sends `tenantSlug=<lock>` to the backend `/admin/auth/login` route. |
| `dashboard/app/login/page.tsx` | Header text reads "Sign in to the &lt;slug&gt; admin panel". |

## What it does NOT change

- The chatagent backend still applies the same auth and tenant isolation
  for every request. The lock is a UX guarantee, not a security boundary.
  Tenant isolation is enforced server-side by JWT `tenantId` regardless of
  which dashboard URL the request originates from.
- Super-admin users can still log in to a sub-portal (their JWT carries
  super_admin role), but the UI will hide the tenant switcher and the
  `/tenants` page. To do cross-tenant work, they should use the platform
  dashboard URL.

## Reset

To turn a sub-portal back into a platform dashboard, remove
`NEXT_PUBLIC_TENANT_SLUG_LOCK` from the Vercel env and redeploy. No data
changes needed.
