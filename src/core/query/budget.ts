import { DomainError } from '../errors.js';

export class QueryBudgetError extends DomainError {
  constructor() {
    super('INVALID_QUERY', 'Query exceeds the request budget; reduce selected fields, nested lists, or page sizes');
  }
}

/** Общий бюджет одного запроса, включая повторные выборки и развёрнутые связи.
 * @example Две ветви union или два GraphQL alias расходуют один и тот же экземпляр.
 */
export class QueryBudget {
  private work = 100_000;
  private records = 10_000;
  private bytes = 8 * 1024 * 1024;
  private selections = 1_000;
  private failure?: QueryBudgetError;

  consume(amount = 1): void {
    if (this.failure) throw this.failure;
    this.work -= amount;
    if (this.work < 0) this.exceeded();
  }

  select(): void {
    if (--this.selections < 0) this.exceeded();
    this.consume();
  }

  record(amount = 1): void {
    this.records -= amount;
    if (this.records < 0) this.exceeded();
    this.consume(amount);
    this.outputBytes(amount * 2);
  }

  field(name: string): void {
    this.consume();
    this.outputBytes(name.length * 6 + 4);
  }

  /** Оценивает верхнюю границу JSON до копирования значения; строки учитывают escaping.
   * @example scalar(['x', null]) учитывает элементы массива и их размер в результате.
   */
  scalar(value: unknown): void {
    this.consume();
    if (Array.isArray(value)) {
      this.outputBytes(value.length + 2);
      for (const item of value) this.scalar(item);
    } else if (value && typeof value === 'object') {
      this.outputBytes(2);
      for (const [key, item] of Object.entries(value)) {
        this.field(key);
        this.scalar(item);
      }
    } else this.outputBytes(typeof value === 'string' ? value.length * 6 + 2 : typeof value === 'number' ? 25 : 5);
  }

  private outputBytes(amount: number): void {
    this.bytes -= amount;
    if (this.bytes < 0) this.exceeded();
  }

  private exceeded(): never {
    this.failure ??= new QueryBudgetError();
    throw this.failure;
  }
}
