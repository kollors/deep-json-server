import type { RecordOptions } from '../lifecycle/options.js';
import type { JsonValue } from '../types.js';
export interface Field {
  type: string;
  description?: string;
  example?: JsonValue;
  required?: boolean;
  nullable?: boolean;
  default?: JsonValue;
  enum?: JsonValue[];
  primary?: boolean;
  generated?: 'uuid' | 'increment';
  readOnly?: boolean;
  writeOnly?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'date' | 'date-time' | 'email' | 'uri' | 'uuid';
  minimum?: number;
  maximum?: number;
  source?: string;
  target?: string;
  onDelete?: 'restrict' | 'cascade';
}
export interface EntityDefinition {
  timestamps?: boolean;
  softDelete?: boolean;
  collection: string;
  api?: ('openapi' | 'graphql')[];
  fields: Record<string, Field>;
}
export type ApiFormat = 'openapi' | 'graphql';
export interface ModelSchema {
  models: Record<string, EntityDefinition>;
  api?: ApiFormat[];
  timestamps?: boolean;
  softDelete?: boolean;
}
export interface ModelOptions {
  auth?: boolean;
  api?: ApiFormat[];
}
interface NodeFields extends Field {
  system?: boolean;
  internal?: boolean;
  virtual?: 'actions';
  softDelete?: boolean;
  path: string;
  base: string;
  many: boolean;
  children: Record<string, Node>;
  implicit?: boolean;
  mixed?: boolean;
  relationKey?: boolean;
}
export interface ValueNode extends NodeFields {
  relation?: undefined;
}
export interface RelationNode extends NodeFields {
  relation: Entity;
  source: string;
  target: string;
}
export type Node = ValueNode | RelationNode;
export interface Entity {
  timestamps: boolean;
  softDelete: boolean;
  name: string;
  collection: string;
  api: ('openapi' | 'graphql')[];
  primary: string;
  fields: Record<string, Node>;
  root: Node;
}
export interface Model {
  options: Required<RecordOptions>;
  entities: Entity[];
  byName: Map<string, Entity>;
  byCollection: Map<string, Entity>;
  explicit: boolean;
}
export type ValidationSchema = Record<string, unknown>;
