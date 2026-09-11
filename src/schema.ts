import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { printSchema } from 'graphql';
import { buildGraphql } from './graphql.js';
import { assertApi, loadModel, type ModelSchema } from './model.js';
import { buildOpenapiDocument } from './openapi/document.js';
import { createOpenapi } from './openapi/index.js';
export interface OpenapiOptions {
  files?: boolean;
  host?: string;
  port?: number;
  pageSize?: number;
  maxPageSize?: number;
  info?: { title: string; version: string; description?: string };
}
export async function generateOpenapi(schema: ModelSchema | string, options: OpenapiOptions = {}) {
  const model = await loadModel(schema);
  assertApi(model, 'openapi');
  return createOpenapi({ document: buildOpenapiDocument({ model, ...options }), host: options.host, port: options.port });
}
export async function generateGraphql(schema: ModelSchema | string): Promise<string> {
  const model = await loadModel(schema);
  assertApi(model, 'graphql');
  return printSchema(buildGraphql(model));
}
export async function writeGraphql(sdl: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${sdl}\n`, 'utf8');
}
export { writeOpenapi } from './openapi/index.js';
