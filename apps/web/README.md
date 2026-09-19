# LeRoutier (unified PWA)

The canonical LeRoutier frontend: one installable app, one identity, several
authorized workspaces, one `/api/v1` backend.

```bash
pnpm --filter @leroutier/web dev      # http://localhost:3003
pnpm --filter @leroutier/web build
```

`VITE_API_URL` points at the shared API. Local development defaults to
`http://127.0.0.1:4000`; a Vercel build without the variable ships no URL at
all rather than a localhost fallback.

The unified app owns the workspace model, route map, PWA shell and same-origin
API proxy. Legacy app directories are compatibility-only.

Screens are shared with the legacy apps through `@leroutier/screens`, so there
is one source of truth for passenger, crew and ops UI.
