# Pit Artifact Storage API

First iteration of the backend API that stores, versions, and serves **artifacts** produced by
Pit pipeline runs. Pipeline agents upload artifacts to a **system**; browser clients (the Pit
dashboard) list them, get notified in real time when new ones appear, and download them.

Domain model: `Customer 1:N System 1:N Artifact`. This iteration's API is scoped by
`systemId`; customers are modeled in the schema for extensibility but have no endpoints.
Re-uploading an artifact with the same name to the same system creates a **new version**
(v1, v2, ...); nothing is overwritten.

## How to run

Requires Docker with the Compose plugin. From the repo root:

```bash
docker compose up --build
```

This starts the API on `http://localhost:3000` and a PostgreSQL 16 instance, each with a
named volume (blobs + database). Migrations run automatically on app startup.

There is a tiny demo page at **http://localhost:3000/demo**: connect to a system's event
stream, upload a file, and watch the `artifact.created` event arrive live.

### Try it with curl

```bash
# Upload an artifact (creates the system lazily on first use)
curl -X POST http://localhost:3000/api/v1/systems/sys_alpha/artifacts \
  -F "file=@schema.sql;type=application/sql"

# Upload again under the same name -> version 2
curl -X POST http://localhost:3000/api/v1/systems/sys_alpha/artifacts \
  -F "file=@schema.sql;type=application/sql"

# List artifacts for a system (pagination + optional name filter)
curl "http://localhost:3000/api/v1/systems/sys_alpha/artifacts?limit=50&offset=0"
curl "http://localhost:3000/api/v1/systems/sys_alpha/artifacts?name=schema.sql"

# Get one artifact's metadata
curl http://localhost:3000/api/v1/systems/sys_alpha/artifacts/<artifactId>

# Download the content
curl -OJ http://localhost:3000/api/v1/systems/sys_alpha/artifacts/<artifactId>/content

# Subscribe to new-artifact notifications (SSE)
curl -N http://localhost:3000/api/v1/systems/sys_alpha/events
```

From a browser the stream is just:

```js
const es = new EventSource('http://localhost:3000/api/v1/systems/sys_alpha/events');
es.addEventListener('artifact.created', (e) => console.log(JSON.parse(e.data)));
```

## API reference

Base path `/api/v1`. Metadata is JSON; uploads are `multipart/form-data`; notifications are
`text/event-stream`. IDs are server-generated UUIDs, timestamps are ISO-8601 UTC.

| Method & path                                            | Purpose                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /systems/{systemId}/artifacts`                     | Upload an artifact. Fields: `file` (required), `name` (optional override; must be sent **before** `file`, see assumptions). Returns `201` + metadata. |
| `GET /systems/{systemId}/artifacts?limit=&offset=&name=` | List artifacts. `limit` 1 to 200 (default 50), `offset` ≥ 0, `name` filters to all versions of that name. Empty system → `[]`.                        |
| `GET /systems/{systemId}/artifacts/{artifactId}`         | Artifact metadata, or `404`.                                                                                                                          |
| `GET /systems/{systemId}/artifacts/{artifactId}/content` | Streams the stored bytes with `Content-Type`, `Content-Length`, `Content-Disposition`.                                                                |
| `GET /systems/{systemId}/events`                         | SSE stream scoped to the system. Emits `artifact.created` events; sends `: keep-alive` comments periodically.                                         |
| `GET /health` / `GET /health/ready`                      | Liveness / readiness (checks database connectivity).                                                                                                  |
| `GET /demo`                                              | Minimal built-in demo page for the SSE flow.                                                                                                          |

Upload response (also the SSE event payload):

```json
{
  "id": "9f1c2b0e-6d3a-4b2f-9c1a-2b3c4d5e6f70",
  "systemId": "sys_alpha",
  "name": "schema.sql",
  "contentType": "application/sql",
  "size": 20481,
  "version": 1,
  "checksum": "sha256:3b2c...e9",
  "createdAt": "2026-07-05T10:00:00.000Z",
  "links": {
    "self": "/api/v1/systems/sys_alpha/artifacts/9f1c2b0e-...",
    "content": "/api/v1/systems/sys_alpha/artifacts/9f1c2b0e-.../content"
  }
}
```

All errors use one envelope:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```

Codes: `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `PAYLOAD_TOO_LARGE` (413),
`UNSUPPORTED_MEDIA_TYPE` (415), `INTERNAL_ERROR` (500).

## Architecture

```
HTTP (Fastify routes)          validation, multipart streaming, SSE connections
  └─ ArtifactService           versioning rules, blob→metadata write ordering, event publish
       ├─ ArtifactRepository   interface → Drizzle/PostgreSQL implementation
       ├─ BlobStorage          interface → local filesystem (Docker volume)
       └─ EventBus             interface → in-process pub/sub → SseManager fan-out
```

- **Upload path:** stream blob to disk (hashing + counting on the way through) → insert
  metadata row (version assigned atomically in the INSERT, unique index + retry guards
  races) → publish `artifact.created` → SSE manager writes the event to every open
  connection for that system. A failed metadata insert deletes the blob, so no orphans.
- **Uploads and downloads stream end-to-end**; file content is never buffered in memory.
- **Blob paths are built only from server-generated IDs** (`{systemId}/{artifactId}`);
  the uploaded filename is metadata only, so path traversal is structurally impossible
  (and belt-and-braces checked in the storage layer).

## Tests

Run locally (no Docker needed):

```bash
npm install
npm test          # vitest: 30 tests
npm run lint
npm run typecheck
```

Coverage focus: versioning semantics, blob round-trip + checksum + partial-write cleanup,
orphan prevention, every endpoint's happy path and key errors (400/404/413/415), and the
SSE flow over real HTTP connections (delivery, multi-subscriber fan-out, per-system
scoping, disconnect cleanup).

The HTTP tests run against an in-memory repository + temp-dir blob storage (the interfaces
exist for exactly this). The PostgreSQL repository is exercised by running the compose
stack; with more time I'd add a testcontainers-style integration test for it.

## Persistence check

```bash
docker compose up --build -d
curl -X POST http://localhost:3000/api/v1/systems/sys_alpha/artifacts -F "file=@schema.sql"
docker compose down          # NOT -v: volumes survive
docker compose up -d
curl "http://localhost:3000/api/v1/systems/sys_alpha/artifacts"   # artifact still there
```

Both the blob volume (`artifact_data`) and the database volume (`db_data`) are named
volumes, so metadata and content survive restarts. (`docker compose down -v` wipes them.)

## Configuration

Copy `.env.example` to `.env` to override defaults. Compose reads it automatically.

| Variable           | Default                          | Purpose                                 |
| ------------------ | -------------------------------- | --------------------------------------- |
| `PORT`             | `3000`                           | HTTP port                               |
| `HOST`             | `0.0.0.0`                        | Bind address                            |
| `STORAGE_ROOT`     | `/data/artifacts`                | Blob directory (volume mount)           |
| `MAX_UPLOAD_BYTES` | `104857600` (100 MiB)            | Upload size cap → `413`                 |
| `DATABASE_URL`     | `postgres://pit:pit@db:5432/pit` | Metadata store                          |
| `CORS_ORIGINS`     | `http://localhost:5173`          | Comma-separated allowed browser origins |
| `SSE_KEEPALIVE_MS` | `20000`                          | Keep-alive comment interval             |
| `LOG_LEVEL`        | `info`                           | pino log level                          |

## Assumptions

1. **Systems are created lazily** on first upload (with a placeholder customer), so the API
   is demoable without seeding. In production, systems would be provisioned explicitly and
   an upload to an unknown system would 404.
2. **No authentication** in this iteration (per the brief; the service sits behind a trusted
   boundary). The seam: one auth plugin gating `/api/v1`, with API keys/mTLS for pipeline
   agents, JWT for dashboard users, per-system authorization on top. All queries and blob
   paths are already keyed by `systemId`, which is the foundation for tenant isolation.
3. **Single service instance.** The event bus is in-process; browsers connected to another
   instance would miss events. The bus is behind an interface so Redis pub/sub is a drop-in
   for multi-instance fan-out.
4. **Notifications are best-effort.** A client that is offline when an artifact is created
   catches up via the list endpoint on reconnect; there is no missed-event replay.
5. **Content is stored as-is**; `contentType` comes from the upload (falling back to
   `application/octet-stream`). No validation or scanning of file contents.
6. **Upload size is capped** (100 MiB default, configurable).
7. The optional `name` override field must appear **before** the `file` part in the
   multipart body. Multipart is processed as a stream (to avoid buffering large files), so
   fields after the file aren't visible when the file is stored, the same constraint S3
   presigned POSTs have.
8. Database credentials in `docker-compose.yml` are throwaway dev defaults (overridable via
   `POSTGRES_PASSWORD`); real deployments would inject secrets from the environment.

## Trade-offs & decisions

- **SSE over WebSockets/long-polling** for notifications: the requirement is strictly
  server→browser, and SSE is HTTP-native, works with `EventSource` (auto-reconnect built
  in), needs no extra dependency, and passes proxies/CORS like any GET. WebSockets would
  only earn their complexity if the dashboard needed to push data back.
- **PostgreSQL over SQLite** for metadata: compose is required anyway, so a real DB is
  low marginal cost and shows genuine schema/index/migration decisions (unique index on
  `(system_id, name, version)` makes concurrent version assignment safe). SQLite on a
  volume would be the leaner call if minimizing moving parts mattered most.
- **Filesystem blobs over S3/MinIO**: simplest correct persistence for a first iteration;
  hidden behind a `BlobStorage` interface so object storage is a swap, not a rewrite.
- **Fastify over Express**: first-class TypeScript, streaming multipart, structured
  logging (pino) out of the box.
- **Hand-rolled SQL migration runner** (ordered, embedded, advisory-locked) instead of
  drizzle-kit migration folders: zero extra build tooling, self-contained compiled output.
  With a growing schema I'd switch to drizzle-kit generated migrations.
- **Versioning is non-destructive** (`version = max + 1` per `(systemId, name)`): honors
  the "versioned" domain requirement and avoids destructive uploads, at ~20 lines of cost.
- **Strict-input posture**: pagination `limit` above 200 is rejected (400) rather than
  clamped; malformed UUIDs are 400 (not 404); system IDs are slug-validated (also what
  makes them safe as directory names).

### Deliberately not built (and why)

- **Delete (FR-8, "could")**: cut for time; the layering makes it mechanical (route →
  service → repo delete + blob delete). Left out rather than rushed.
- **Auth/authz**: out of scope per the brief; seam documented above.
- **Multi-instance event delivery** (Redis pub/sub), **object storage**, **encryption at
  rest**, **rate limiting/quotas**, **audit logging**, **content scanning**, **signed
  download URLs**, **customer/system CRUD**: all noted as the natural next steps, none
  needed to prove the core loop.

## Tooling notes

- `.nvmrc` pins the Node version; `nvm use` picks it up.
- A pre-commit hook (`.githooks/pre-commit`) runs prettier check, lint, typecheck, and the
  test suite. `npm install` wires it up automatically (the `prepare` script sets
  `core.hooksPath`); run it manually with `sh .githooks/pre-commit`.

## Development without Docker

```bash
npm install
docker compose up db -d        # or any local PostgreSQL
DATABASE_URL=postgres://pit:pit@localhost:5432/pit npm run dev
```

Note: `docker compose up db` publishes no host port by default; add a `ports` mapping for
the `db` service (e.g. `5432:5432`) if you run the app outside compose.
