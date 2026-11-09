// Ignore case and whitespace in both the catalogue name and the query.
export const normalizeMixtureSearch = (value: string) =>
  value.toLocaleLowerCase("ru-RU").replace(/\s+/gu, "");
export const matchesMixture = (name: string, query: string) =>
  normalizeMixtureSearch(name).includes(normalizeMixtureSearch(query));
