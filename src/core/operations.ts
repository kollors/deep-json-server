/** Описывает изменения записей: метод, наличие ключа и тела, код успешного ответа.
 * @example MUTATIONS[0] → { mode: 'create', method: 'POST', hasKey: false, hasBody: true, status: 201 }.
 */
export const MUTATIONS = [
  { mode: 'create', method: 'POST', hasKey: false, hasBody: true, status: 201 },
  { mode: 'replace', method: 'PUT', hasKey: true, hasBody: true, status: 200 },
  { mode: 'update', method: 'PATCH', hasKey: true, hasBody: true, status: 200 },
  { mode: 'delete', method: 'DELETE', hasKey: true, hasBody: false, status: 200 },
] as const;

export type Mutation = (typeof MUTATIONS)[number];
export type MutationMode = Mutation['mode'];
export type WriteMode = Extract<Mutation, { hasBody: true }>['mode'];
