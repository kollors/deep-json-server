import type { OpenapiContent, OpenapiResponse, OpenapiSchema } from './types.js';
/** Создаёт ссылку на именованную схему компонента.
 * @example ref('User') → { $ref: '#/components/schemas/User' }.
 */
export const ref = (name: string): OpenapiSchema => ({ $ref: `#/components/schemas/${name}` });
/** Оборачивает схему в описание тела application/json.
 * @example json({ type: 'string' }) → { content: { 'application/json': { schema: { type: 'string' } } } }.
 */
export const json = (schema: OpenapiSchema): OpenapiContent => ({ content: { 'application/json': { schema } } });
/** Создаёт описание ответа; тело добавляется только при переданной схеме.
 * @example response('No content') → { description: 'No content' }.
 */
export const response = (description: string, schema?: OpenapiSchema): OpenapiResponse => ({ description, ...(schema === undefined ? {} : json(schema)) });
