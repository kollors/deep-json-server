/** Проверяет, что пути не повторяются и не перекрывают коллекции или файловые маршруты.
 * @example validateEndpoints(['users'], ['/users/1']) → ошибка; ['users'], ['/api'] → undefined.
 */
export function validateEndpoints(collections: string[], endpoints: string[]): void {
  if (new Set(endpoints).size !== endpoints.length) throw new Error('API endpoints conflict');
  for (const endpoint of endpoints)
    if (collections.some((collection) => endpoint === `/${collection}` || endpoint.startsWith(`/${collection}/`)) || endpoint.startsWith('/_files/'))
      throw new Error(`API endpoint conflicts with a resource route: ${endpoint}`);
}
