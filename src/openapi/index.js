import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stringify } from 'yaml';
import { readDatabaseFile } from '../database.js';
import { readSchemaConfig } from './config.js';
import { createOpenApiDocument } from './document.js';

export { createOpenApiDocument } from './document.js';

/**
 * Generates an OpenAPI YAML file.
 * @param {{ databasePath: string, files?: boolean, host?: string, outputPath: string, port?: number, schemaPath?: string }} options Generation options.
 * @returns {Promise<Record<string, unknown>>} Generated OpenAPI document.
 */
export async function generateOpenApi({ databasePath, files = false, host, outputPath, port, schemaPath }) {
  const database = await readDatabaseFile(databasePath);
  const schemaConfig = await readSchemaConfig(schemaPath);
  const document = createOpenApiDocument(database, schemaConfig, { files, host, port });
  const resolvedOutputPath = resolve(outputPath);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 }), 'utf8');

  return document;
}
