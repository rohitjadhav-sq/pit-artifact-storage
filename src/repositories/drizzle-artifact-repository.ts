import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { artifacts, customers, systems } from '../db/schema.js';
import type { Artifact, ArtifactListQuery, ArtifactPage, NewArtifact } from '../types/artifact.js';
import type { ArtifactRepository } from './artifact-repository.js';

const PLACEHOLDER_CUSTOMER_ID = 'default';

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: string; cause?: { code?: string } };
  return err.code === '23505' || err.cause?.code === '23505';
}

export class DrizzleArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: Db) {}

  async ensureSystem(systemId: string): Promise<void> {
    await this.db
      .insert(customers)
      .values({ id: PLACEHOLDER_CUSTOMER_ID, name: 'Default Customer' })
      .onConflictDoNothing();
    await this.db
      .insert(systems)
      .values({ id: systemId, customerId: PLACEHOLDER_CUSTOMER_ID, name: systemId })
      .onConflictDoNothing();
  }

  async create(input: NewArtifact): Promise<Artifact> {
    // The version is computed inside the INSERT; the unique index on
    // (system_id, name, version) turns a concurrent race into a 23505, which we retry.
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        const rows = await this.db
          .insert(artifacts)
          .values({
            id: input.id,
            systemId: input.systemId,
            name: input.name,
            contentType: input.contentType,
            size: input.size,
            version: sql<number>`(
              SELECT COALESCE(MAX(${artifacts.version}), 0) + 1
              FROM ${artifacts}
              WHERE ${artifacts.systemId} = ${input.systemId}
                AND ${artifacts.name} = ${input.name}
            )`,
            checksum: input.checksum,
            storageKey: input.storageKey,
            createdAt: input.createdAt,
          })
          .returning();
        const row = rows[0];
        if (!row) throw new Error('INSERT ... RETURNING produced no row');
        return row;
      } catch (error) {
        if (isUniqueViolation(error) && attempt < maxAttempts) continue;
        throw error;
      }
    }
  }

  async list(systemId: string, query: ArtifactListQuery): Promise<ArtifactPage> {
    const where = query.name
      ? and(eq(artifacts.systemId, systemId), eq(artifacts.name, query.name))
      : eq(artifacts.systemId, systemId);

    const items = await this.db
      .select()
      .from(artifacts)
      .where(where)
      .orderBy(desc(artifacts.createdAt), desc(artifacts.version))
      .limit(query.limit)
      .offset(query.offset);

    const totals = await this.db
      .select({ total: sql<number>`cast(count(*) as int)` })
      .from(artifacts)
      .where(where);

    return { items, total: totals[0]?.total ?? 0 };
  }

  async findById(systemId: string, artifactId: string): Promise<Artifact | null> {
    const rows = await this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.systemId, systemId), eq(artifacts.id, artifactId)))
      .limit(1);
    return rows[0] ?? null;
  }
}
