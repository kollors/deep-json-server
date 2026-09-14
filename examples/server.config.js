export default {
  storage: 'file',
  database: { source: './database.json', schema: './schema.json' },
  graphql: { path: './generated/schema.graphql' },
  openapi: { path: './generated/openapi.yaml' },
  server: { port: 4001, pageSize: 10, maxPageSize: 100 },
};
