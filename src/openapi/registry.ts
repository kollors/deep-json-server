import type { Node } from '../core/model.js';
import type { OpenapiSchema } from './types.js';

/** Хранит схемы OpenAPI и не позволяет разным узлам занять одно имя.
 * @example reserve('User', node) → true при первом вызове и false для того же node.
 */
export class OpenapiRegistry {
  readonly schemas: Record<string, OpenapiSchema>;
  private owners = new Map<string, Node>();
  constructor(initial: Record<string, OpenapiSchema>) {
    this.schemas = initial;
  }
  reserve(name: string, node: Node): boolean {
    if (this.owners.get(name) === node) return false;
    if (this.schemas[name]) throw new Error(`OpenAPI schema name collision: ${name}`);
    this.owners.set(name, node);
    this.schemas[name] = {};
    return true;
  }
}
