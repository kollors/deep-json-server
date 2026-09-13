import type { RecordOptions } from '../core/lifecycle/options.js';
export type GraphqlOptions = RecordOptions;

import { printSchema } from 'graphql';
import { assertApi, loadModel, type Model, type ModelSchema } from '../core/model.js';
import { buildGraphql } from './schema.js';
/** Проверяет доступность формата и возвращает текст схемы из подготовленной модели.
 * @example Подготовленная модель с сущностью Note → SDL с типом Note и операциями note, noteList.
 */
export function graphqlFromModel(model: Model | undefined): string {
  assertApi(model, 'graphql');
  return printSchema(buildGraphql(model));
}
/** Загружает описание из объекта или файла и возвращает текст схемы.
 * @example Корректное описание сущностей → Promise<string> с SDL; некорректное → ошибка.
 */
export async function generateGraphql(schema: ModelSchema | string, options: GraphqlOptions = {}): Promise<string> {
  return graphqlFromModel(await loadModel(schema, options));
}
