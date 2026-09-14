export default {
  storage: 'file',
  database: { source: './database.json', schema: './schema.json' },
  graphql: { target: './generated/schema.graphql' },
  openapi: { target: './generated/openapi.yaml' },
  server: { port: 4001, pageSize: 10, maxPageSize: 100 },
};
