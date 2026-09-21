export type { EntityDefinition, Field, ModelSchema } from '../core/model.js';

import type { ModelSchema } from '../core/model.js';
import type { GraphqlOptions } from './generate.js';
/** Загружает генератор при первом обращении и передаёт ему описание и параметры.
 * @example await generateGraphql({ models: { Note: { collection: 'notes', fields: { id: { type: 'string', primary: true } } } } }) → SDL с типом Note и запросом noteList.
 */
export async function generateGraphql(schema: ModelSchema | string, options?: GraphqlOptions): Promise<string> {
  return (await import('./generate.js')).generateGraphql(schema, options);
}
/** Загружает модуль записи по требованию и сохраняет схему в указанный файл.
 * @example await writeGraphql('type Query { ping: String }', './schema.graphql') → undefined; файл содержит переданную SDL.
 */
export async function writeGraphql(sdl: string, path: string): Promise<void> {
  return (await import('./write.js')).writeGraphql(sdl, path);
}

export type { GraphqlOptions } from './generate.js';
