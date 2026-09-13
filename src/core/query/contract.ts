import type { Node } from '../model.js';
export type Operand = 'value' | 'values' | 'comparison' | 'text' | 'element' | 'condition';
/** Возвращает допустимые операторы и виды их аргументов для типа значения.
 * @example Для boolean без массива → { not: 'condition', eq: 'value', ne: 'value', in: 'values' }.
 */
export const operatorsFor = (node: Node): Record<string, Operand> => {
  const result: Record<string, Operand> = { not: 'condition' };
  if (node.many) {
    Object.assign(result, { some: 'element', every: 'element', none: 'element' });
    if (!node.relation && node.base !== 'object') Object.assign(result, { contains: 'value', in: 'values' });
  } else {
    Object.assign(result, { eq: 'value', ne: 'value', in: 'values' });
    if (node.base !== 'boolean') for (const name of ['gt', 'gte', 'lt', 'lte']) result[name] = 'comparison';
    if (node.base === 'string') for (const name of ['contains', 'startsWith', 'endsWith']) result[name] = 'text';
  }
  return result;
};
