import type { JsonValue } from '../core/types.js';

export type OpenapiType = 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';

export interface OpenapiSchema {
  [key: string]: unknown;
  additionalProperties?: boolean | OpenapiSchema;
  allOf?: OpenapiSchema[];
  anyOf?: OpenapiSchema[];
  default?: JsonValue;
  description?: string;
  enum?: JsonValue[];
  format?: string;
  items?: OpenapiSchema;
  maximum?: number;
  maxItems?: number;
  maxLength?: number;
  minimum?: number;
  minItems?: number;
  minLength?: number;
  not?: OpenapiSchema;
  nullable?: boolean;
  oneOf?: OpenapiSchema[];
  pattern?: string;
  properties?: Record<string, OpenapiSchema>;
  required?: string[];
  title?: string;
  type?: OpenapiType;
  uniqueItems?: boolean;
}

export interface OpenapiDocument {
  [key: string]: unknown;
  components: {
    parameters: Record<string, unknown>;
    schemas: Record<string, OpenapiSchema>;
    securitySchemes?: Record<string, unknown>;
  };
  info: Record<string, unknown>;
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  servers?: Array<{ url: string }>;
}
