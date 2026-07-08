import type { MultipartFields } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { ArtifactService } from '../../services/artifact-service.js';
import { payloadTooLarge, unsupportedMediaType, validationError } from '../errors.js';
import {
  artifactNameSchema,
  artifactParamsSchema,
  listQuerySchema,
  systemParamsSchema,
} from '../schemas.js';
import { contentDisposition, serializeArtifact } from '../serialize.js';

function readStringField(fields: MultipartFields, key: string): string | undefined {
  const field = fields[key];
  const first = Array.isArray(field) ? field[0] : field;
  if (first && first.type === 'field' && typeof first.value === 'string') return first.value;
  return undefined;
}

export function registerArtifactRoutes(
  app: FastifyInstance,
  deps: { artifactService: ArtifactService },
): void {
  app.post('/systems/:systemId/artifacts', async (request, reply) => {
    const { systemId } = systemParamsSchema.parse(request.params);
    if (!request.isMultipart()) {
      throw unsupportedMediaType('Request body must be multipart/form-data.');
    }

    const file = await request.file();
    if (!file) {
      throw validationError('Missing required "file" field in the multipart body.');
    }
    // Note: a "name" override field must be sent before the "file" part, because
    // multipart is processed as a stream and later fields are not visible when the
    // file arrives.
    const nameOverride = readStringField(file.fields, 'name');
    const rawName = nameOverride ?? file.filename;
    if (!rawName) {
      throw validationError('Provide a filename on the "file" part or a "name" field before it.');
    }
    const name = artifactNameSchema.parse(rawName);
    const contentType = file.mimetype || 'application/octet-stream';

    const artifact = await deps.artifactService.upload({
      systemId,
      name,
      contentType,
      content: file.file,
      // busboy silently truncates the stream at limits.fileSize instead of erroring;
      // rejecting here makes the service discard the truncated blob and answer 413.
      afterWrite: () => {
        if (file.file.truncated) {
          throw payloadTooLarge('File exceeds the maximum allowed upload size.');
        }
      },
    });

    request.log.info(
      { artifactId: artifact.id, systemId, name: artifact.name, version: artifact.version },
      'artifact stored',
    );
    return reply.code(201).send(serializeArtifact(artifact));
  });

  app.get('/systems/:systemId/artifacts', async (request) => {
    const { systemId } = systemParamsSchema.parse(request.params);
    const query = listQuerySchema.parse(request.query);
    const page = await deps.artifactService.list(systemId, query);
    return {
      data: page.items.map(serializeArtifact),
      pagination: { limit: query.limit, offset: query.offset, total: page.total },
    };
  });

  app.get('/systems/:systemId/artifacts/:artifactId', async (request) => {
    const { systemId, artifactId } = artifactParamsSchema.parse(request.params);
    const artifact = await deps.artifactService.getById(systemId, artifactId);
    return serializeArtifact(artifact);
  });

  app.get('/systems/:systemId/artifacts/:artifactId/content', async (request, reply) => {
    const { systemId, artifactId } = artifactParamsSchema.parse(request.params);
    const { artifact, stream } = await deps.artifactService.openContent(systemId, artifactId);
    return reply
      .header('content-type', artifact.contentType)
      .header('content-length', String(artifact.size))
      .header('content-disposition', contentDisposition(artifact.name))
      .send(stream);
  });
}
