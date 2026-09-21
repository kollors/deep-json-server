import type { SchemaKeywords, SchemaType } from '../core/schema.js';
import type { JsonValue } from '../core/types.js';
import type { OpenapiInfo } from './options.js';

export type OpenapiType = Exclude<SchemaType, 'null'>;
export interface OpenapiSchema extends SchemaKeywords<OpenapiSchema> {
  [key: `x-${string}`]: JsonValue;
  nullable?: boolean;
  type?: OpenapiType;
}
export interface OpenapiReference {
  $ref: string;
}
export interface OpenapiContent {
  content: Record<string, { schema: OpenapiSchema }>;
}
export interface OpenapiParameter {
  in: 'path' | 'query' | 'header' | 'cookie';
  name: string;
  required?: boolean;
  description?: string;
  schema?: OpenapiSchema;
  content?: OpenapiContent['content'];
}
export interface OpenapiResponse {
  description: string;
  content?: OpenapiContent['content'];
}
export interface OpenapiRequestBody extends OpenapiContent {
  required?: boolean;
  description?: string;
}
export interface OpenapiOperation {
  operationId: string;
  tags?: string[];
  description?: string;
  parameters?: Array<OpenapiParameter | OpenapiReference>;
  security?: Array<Record<string, string[]>>;
  requestBody?: OpenapiRequestBody;
  responses: Record<string, OpenapiResponse | OpenapiReference>;
}
export type OpenapiMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
export type OpenapiPath = Partial<Record<OpenapiMethod, OpenapiOperation>>;
export interface OpenapiSecurityScheme {
  type: 'http';
  scheme: 'bearer';
  description?: string;
}
export interface OpenapiDocument {
  [key: `x-${string}`]: JsonValue;
  components: {
    parameters: Record<string, OpenapiParameter | OpenapiReference>;
    schemas: Record<string, OpenapiSchema>;
    securitySchemes?: Record<string, OpenapiSecurityScheme>;
  };
  info: OpenapiInfo;
  openapi: string;
  paths: Record<string, OpenapiPath>;
  servers?: Array<{ url: string }>;
}
