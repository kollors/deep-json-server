import type { NormalizedServerConfig } from './config.js';
import { isObject } from './utils.js';
export interface ServerFeatures {
  files?: boolean;
  graphql?: boolean;
  openapi?: boolean;
}
export function resolveFeatures(config: NormalizedServerConfig, features: ServerFeatures = {}): Required<ServerFeatures> {
  if (!isObject(features) || Object.entries(features).some(([key, value]) => !['files', 'graphql', 'openapi'].includes(key) || typeof value !== 'boolean'))
    throw new Error('features supports boolean files, graphql and openapi keys');
  const overrides: ServerFeatures = features;
  const resolved = { files: overrides.files ?? config.files != null, graphql: overrides.graphql ?? config.graphql.enabled ?? false, openapi: overrides.openapi ?? config.openapi.enabled ?? false };
  if (resolved.files && !config.files) throw new Error('Для файловых маршрутов укажите секцию config.files');
  return resolved;
}
export function validateEndpoints(collections: string[], endpoints: string[]): void {
  if (new Set(endpoints).size !== endpoints.length) throw new Error('API endpoints conflict');
  for (const endpoint of endpoints)
    if (collections.some((collection) => endpoint === `/${collection}` || endpoint.startsWith(`/${collection}/`)) || endpoint.startsWith('/_files/'))
      throw new Error(`API endpoint conflicts with a resource route: ${endpoint}`);
}
