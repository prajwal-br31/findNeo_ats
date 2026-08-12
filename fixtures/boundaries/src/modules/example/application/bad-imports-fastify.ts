// ER-004: application and domain layers never import HTTP types
import type { FastifyRequest } from 'fastify';
export type Bad = FastifyRequest;
