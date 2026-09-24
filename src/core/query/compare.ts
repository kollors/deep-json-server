const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Задаёт один порядок строк и чисел для фильтров и сортировки. */
export function compareValues(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return collator.compare(String(left), String(right));
}
