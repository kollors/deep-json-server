import type { JsonValue } from './types.js';

export type SchemaType = 'array' | 'boolean' | 'integer' | 'null' | 'number' | 'object' | 'string';

/** Общие свойства схем значений; вложенные схемы используют тип своего формата. */
export interface SchemaKeywords<S> {
  $ref?: string;
  additionalProperties?: boolean | S;
  allOf?: S[];
  anyOf?: S[];
  default?: JsonValue;
  description?: string;
  enum?: JsonValue[];
  example?: JsonValue;
  format?: string;
  items?: S;
  maximum?: number;
  maxItems?: number;
  maxLength?: number;
  minimum?: number;
  minItems?: number;
  minLength?: number;
  not?: S;
  oneOf?: S[];
  pattern?: string;
  properties?: Record<string, S>;
  readOnly?: boolean;
  required?: string[];
  title?: string;
  uniqueItems?: boolean;
  writeOnly?: boolean;
}

export interface ValidationSchema extends SchemaKeywords<ValidationSchema> {
  type?: SchemaType | SchemaType[];
}
