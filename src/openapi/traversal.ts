import type { OpenapiSchema } from '../types.js';

export const COMPOSITION_KEYWORDS = ['oneOf', 'anyOf', 'allOf'] as const;

/** Visits positive composition branches without discarding sibling keywords. */
export const mapCompositions = (schema: OpenapiSchema, visit: (schema: OpenapiSchema) => OpenapiSchema): OpenapiSchema => {
  const result = { ...schema };

  for (const keyword of COMPOSITION_KEYWORDS) {
    if (schema[keyword] != null) {
      result[keyword] = schema[keyword].map(visit);
    }
  }

  return result;
};

/** Defaults remain documentation annotations, but must not insert PATCH fields. */
export const withoutDefaults = (schema: OpenapiSchema): OpenapiSchema => {
  const result = mapCompositions(schema, withoutDefaults);

  delete result.default;

  if (schema.properties != null) {
    result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, withoutDefaults(value)]));
  }

  if (schema.items != null) {
    result.items = withoutDefaults(schema.items);
  }

  if (schema.not != null) {
    result.not = withoutDefaults(schema.not);
  }

  if (typeof schema.additionalProperties === 'object' && schema.additionalProperties != null) {
    result.additionalProperties = withoutDefaults(schema.additionalProperties);
  }

  return result;
};
