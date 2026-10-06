# @iswesolutions/plugin-dhis2-backend

Backend plugin powering the DHIS2 frontend plugin.

## Routes

All routes require an authenticated Backstage user.

- `POST /api/dhis2/databases/test`
  - Body: `{ host, port, user, password }`
  - Response: `{ ok: boolean, message: string, code?: string, serverVersion?: string, durationMs: number }`
- `POST /api/dhis2/databases/list`
  - Body: `{ host, port, user, password }`
  - Response: `{ databases: string[] }` on success, `{ error, code }` on failure.

Credentials are taken from the request body (typed into the Create Instance dialog) and are never logged.
