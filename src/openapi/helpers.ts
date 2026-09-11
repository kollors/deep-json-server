import type { OpenapiSchema } from '../types.js';
export const ref = (name: string): OpenapiSchema => ({ $ref: `#/components/schemas/${name}` });
export const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
export const response = (description: string, schema?: unknown) => ({ description, ...(schema === undefined ? {} : json(schema)) });
