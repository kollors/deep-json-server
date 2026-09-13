import type { ModelSchema } from '../core/model.js';
import type { GraphqlOptions } from './public.js';
/** Загружает генератор при первом обращении и передаёт ему описание и параметры.
 * @example Описание и параметры → Promise со схемой; при импорте этой обёртки генератор ещё не загружается.
 */
export async function generateGraphql(schema: ModelSchema | string, options?: GraphqlOptions): Promise<string> {
  return (await import('./public.js')).generateGraphql(schema, options);
}
/** Загружает модуль записи по требованию и сохраняет схему в указанный файл.
 * @example Схема и путь → Promise<void>; файл появляется после успешного завершения.
 */
export async function writeGraphql(sdl: string, path: string): Promise<void> {
  return (await import('./write.js')).writeGraphql(sdl, path);
}
