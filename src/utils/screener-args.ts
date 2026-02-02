export interface ScreenerArgs {
  filters: unknown[];
  limit?: number;
  use_cache?: boolean;
}

function extractJsonArray(text: string, label: string): unknown[] {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(label.toLowerCase());
  if (idx < 0) {
    throw new Error(`Missing ${label}`);
  }
  const start = text.indexOf('[', idx);
  if (start < 0) {
    throw new Error(`Missing array for ${label}`);
  }
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
    if (depth === 0) {
      const raw = text.slice(start, i + 1);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`Expected array for ${label}`);
      }
      return parsed;
    }
  }
  throw new Error(`Unterminated array for ${label}`);
}

function parseFiltersFallback(text: string): unknown[] {
  const fieldMatch = text.match(/field\s*[:=]\s*\"?([a-zA-Z_][\w]*)\"?/i);
  const operatorMatch = text.match(/operator\s*[:=]\s*\"?([a-z]+)\"?/i);
  const valueMatch = text.match(/value\s*[:=]\s*([0-9.]+)/i);
  if (!fieldMatch || !operatorMatch || !valueMatch) {
    throw new Error('Failed to parse JSON');
  }
  return [{
    field: fieldMatch[1],
    operator: operatorMatch[1],
    value: Number(valueMatch[1]),
  }];
}

export function parseScreenerArgs(query: string): ScreenerArgs {
  const trimmed = query.trim();
  let filters: unknown[];
  try {
    filters = extractJsonArray(trimmed, 'filters');
  } catch {
    filters = parseFiltersFallback(trimmed);
  }
  const limitMatch = trimmed.match(/limit\s*=\s*(\d+)/i);
  const useCacheMatch = trimmed.match(/use_cache\s*=\s*(true|false)/i);
  return {
    filters,
    limit: limitMatch ? Number(limitMatch[1]) : undefined,
    use_cache: useCacheMatch ? useCacheMatch[1].toLowerCase() === 'true' : undefined,
  };
}
