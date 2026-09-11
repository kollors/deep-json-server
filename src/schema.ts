import type { ModelSchema } from './model.js';
import type { OpenapiOptions } from './openapi/public.js';
import type { OpenapiDocument } from './types.js';

export type { OpenapiOptions } from './openapi/public.js';
export async function generateOpenapi(schema: ModelSchema | string, options?: OpenapiOptions): Promise<OpenapiDocument> {
  return (await import('./openapi/public.js')).generateOpenapi(schema, options);
}
export async function generateGraphql(schema: ModelSchema | string): Promise<string> {
  return (await import('./graphql/public.js')).generateGraphql(schema);
}
export async function writeOpenapi(document: OpenapiDocument, path: string): Promise<void> {
  return (await import('./openapi/index.js')).writeOpenapi(document, path);
}
export async function writeGraphql(sdl: string, path: string): Promise<void> {
  return (await import('./graphql/write.js')).writeGraphql(sdl, path);
}
