import type { ModelSchema } from '../core/model.js';
import type { OpenapiOptions } from './public.js';
import type { OpenapiDocument } from './types.js';
/** Загружает генератор при первом обращении и передаёт ему описание и параметры.
 * @example Описание и параметры → Promise со схемой; при импорте этой обёртки генератор ещё не загружается.
 */
export async function generateOpenapi(schema: ModelSchema | string, options?: OpenapiOptions): Promise<OpenapiDocument> {
  return (await import('./public.js')).generateOpenapi(schema, options);
}
/** Загружает модуль записи по требованию и сохраняет схему в указанный файл.
 * @example Схема и путь → Promise<void>; файл появляется после успешного завершения.
 */
export async function writeOpenapi(document: OpenapiDocument, path: string): Promise<void> {
  return (await import('./index.js')).writeOpenapi(document, path);
}
