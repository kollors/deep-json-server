export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type DatabaseId = number | string;
export type DatabaseRecord = JsonObject & { id: DatabaseId };
export type DatabaseData = Record<string, DatabaseRecord[]>;

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
  };
  info: Record<string, unknown>;
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  servers?: Array<{ url: string }>;
}

export type QueryValue = string | string[] | undefined;
export type Query = Record<string, QueryValue>;
