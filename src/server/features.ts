import { isObject } from '../core/utils.js';
import type { NormalizedServerConfig } from './config.js';
export interface ServerFeatures {
  auth?: boolean;
  files?: boolean;
  graphql?: boolean;
  openapi?: boolean;
}
/** Вычисляет включённые модули с учётом явных переопределений и проверяет обязательные настройки.
 * @example Пустые секции и переопределение { graphql: true } → graphql: true, остальные флаги false.
 */
export function resolveFeatures(config: NormalizedServerConfig, features: ServerFeatures = {}): Required<ServerFeatures> {
  if (!isObject(features) || Object.entries(features).some(([key, value]) => !['files', 'graphql', 'openapi', 'auth'].includes(key) || typeof value !== 'boolean'))
    throw new Error('features supports boolean files, graphql, openapi and auth keys');
  const overrides: ServerFeatures = features;
  const resolved = {
    auth: overrides.auth ?? config.auth != null,
    files: overrides.files ?? config.files != null,
    graphql: overrides.graphql ?? config.graphql.enabled ?? false,
    openapi: overrides.openapi ?? config.openapi.enabled ?? false,
  };
  if (resolved.auth && !config.auth) throw new Error('Укажите config.auth.users для включения auth');
  if (resolved.files && !config.files) throw new Error('Для файловых маршрутов укажите секцию config.files');
  return resolved;
}
/** Проверяет, что пути не повторяются и не перекрывают коллекции или файловые маршруты.
 * @example validateEndpoints(['users'], ['/users/1']) → ошибка; ['users'], ['/api'] → undefined.
 */
export function validateEndpoints(collections: string[], endpoints: string[]): void {
  if (new Set(endpoints).size !== endpoints.length) throw new Error('API endpoints conflict');
  for (const endpoint of endpoints)
    if (collections.some((collection) => endpoint === `/${collection}` || endpoint.startsWith(`/${collection}/`)) || endpoint.startsWith('/_files/'))
      throw new Error(`API endpoint conflicts with a resource route: ${endpoint}`);
}
