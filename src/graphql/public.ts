import { printSchema } from 'graphql';
import { buildGraphql } from '../graphql.js';
import { assertApi, loadModel, type Model, type ModelSchema } from '../model.js';
export function graphqlFromModel(model: Model | undefined): string {
  assertApi(model, 'graphql');
  return printSchema(buildGraphql(model));
}
export async function generateGraphql(schema: ModelSchema | string): Promise<string> {
  return graphqlFromModel(await loadModel(schema));
}
