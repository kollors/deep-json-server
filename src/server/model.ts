import type { ApiFormat, Model } from '../core/model.js';
import type { NormalizedServerConfig } from './config.js';

const models = new WeakMap<NormalizedServerConfig, Promise<Model | undefined>>();
/** Загружает схему один раз для заданного объекта настроек; база и учётные записи не читаются.
 * @example Повторные вызовы с одним config → тот же Promise<Model | undefined>.
 */
export function configuredModel(config: NormalizedServerConfig): Promise<Model | undefined> {
  let model = models.get(config);
  if (!model) {
    const api: ApiFormat[] = [...(config.openapi ? ['openapi' as const] : []), ...(config.graphql ? ['graphql' as const] : [])];
    model = import('../core/model.js').then(({ loadModel }) => loadModel(config.database.schema, { auth: config.auth !== undefined, api }));
    models.set(config, model);
  }
  return model;
}
