export interface PageQuery {
  page: number;
  limit: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export const offsetOf = ({ page, limit }: PageQuery) => (page - 1) * limit;

export function paginated<T>(
  items: T[],
  total: number,
  { page, limit }: PageQuery,
): Paginated<T> {
  return { items, total, page, limit };
}
