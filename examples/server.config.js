export default {
  database: { path: './database.json', schema: './schema.json' },
  graphql: { enabled: true, path: './generated/schema.graphql' },
  openapi: { path: './generated/openapi.yaml' },
  server: { port: 4001, pageSize: 10, maxPageSize: 100 },
};
