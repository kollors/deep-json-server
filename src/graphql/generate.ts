import { assertKnownKeys } from '../core/utils.js';
export interface GraphqlOptions {
  auth?: boolean;
}

import { printSchema } from 'graphql';
import { loadModel, type Model, type ModelSchema } from '../core/model.js';
import { buildGraphql } from './schema.js';
/** Проверяет доступность формата и возвращает текст схемы из подготовленной модели.
 * @example Подготовленная модель с сущностью Note → SDL с типом Note и операциями note, noteList.
 */
export function graphqlFromModel(model: Model | undefined): string {
  return printSchema(buildGraphql(model));
}
/** Загружает описание из объекта или файла и возвращает текст схемы.
 * @example Корректное описание сущностей → Promise<string> с SDL; некорректное → ошибка.
 */
export async function generateGraphql(schema: ModelSchema | string, options: GraphqlOptions = {}): Promise<string> {
  assertKnownKeys(options, new Set(['auth']), 'options');
  return graphqlFromModel(await loadModel(schema, { auth: options.auth, api: ['graphql'] }));
}
