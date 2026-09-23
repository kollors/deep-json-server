import type { ApiFormat, Model } from '../core/model.js';
import type { NormalizedServerConfig } from './config.js';

const models = new WeakMap<NormalizedServerConfig, Promise<Model | undefined>>();
/** Загружает схему один раз для заданного объекта настроек; база и учётные записи не читаются.
 * @example Повторные вызовы с одним config → тот же Promise<Model | undefined>.
 */
export function configuredModel(config: NormalizedServerConfig): Promise<Model | undefined> {
  let model = models.get(config);
  if (!model) {
    const api: ApiFormat[] = config.graphql ? ['rest', 'graphql'] : ['rest'];
    model = import('../core/model.js').then(async ({ assertApi, loadModel }) => {
      const validateApi: typeof assertApi = assertApi;
      const loaded = await loadModel(config.database.schema, { auth: config.auth !== undefined, api });
      if (loaded && loaded.api.includes('graphql') !== (config.graphql !== undefined)) throw new Error('schema.api and config.graphql must enable GraphQL together');
      if (loaded?.entities.some((entity) => entity.api.includes('rest'))) validateApi(loaded, 'rest');
      return loaded;
    });
    models.set(config, model);
  }
  return model;
}
