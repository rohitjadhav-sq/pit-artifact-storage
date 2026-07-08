import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const systems = pgTable('systems', {
  id: text('id').primaryKey(),
  customerId: text('customer_id')
    .notNull()
    .references(() => customers.id),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey(),
    systemId: text('system_id')
      .notNull()
      .references(() => systems.id),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    version: integer('version').notNull(),
    checksum: text('checksum').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('artifacts_system_name_version_ux').on(table.systemId, table.name, table.version),
    index('artifacts_system_created_ix').on(table.systemId, table.createdAt),
  ],
);
