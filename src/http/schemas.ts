import { z } from 'zod';

/** Slug-style system IDs; also guarantees the value is safe as a directory name. */
export const systemIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
    'systemId must be 1-64 characters: letters, digits, "_" or "-", starting alphanumeric',
  );

export const artifactIdSchema = z.string().uuid('artifactId must be a UUID');

/** Artifact names are metadata only (never used in filesystem paths). */
export const artifactNameSchema = z
  .string()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'name must not contain control characters');

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  name: artifactNameSchema.optional(),
});

export const systemParamsSchema = z.object({ systemId: systemIdSchema });

export const artifactParamsSchema = z.object({
  systemId: systemIdSchema,
  artifactId: artifactIdSchema,
});
