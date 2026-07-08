import type pg from 'pg';

/**
 * Checked-in, ordered SQL migrations applied at startup. Kept as embedded strings so the
 * compiled output is self-contained (no .sql assets to copy into the image).
 */
const migrations: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: '0001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS customers (
        id         text PRIMARY KEY,
        name       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS systems (
        id          text PRIMARY KEY,
        customer_id text NOT NULL REFERENCES customers(id),
        name        text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id           uuid PRIMARY KEY,
        system_id    text NOT NULL REFERENCES systems(id),
        name         text NOT NULL,
        content_type text NOT NULL,
        size         bigint NOT NULL,
        version      integer NOT NULL,
        checksum     text NOT NULL,
        storage_key  text NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS artifacts_system_name_version_ux
        ON artifacts (system_id, name, version);
      CREATE INDEX IF NOT EXISTS artifacts_system_created_ix
        ON artifacts (system_id, created_at DESC);
    `,
  },
];

const MIGRATION_LOCK_KEY = 727001;

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Advisory lock so concurrent app instances cannot race the migration step.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const migration of migrations) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [
        migration.id,
      ]);
      if (applied.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
