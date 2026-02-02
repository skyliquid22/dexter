import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callApi } from './api.js';
import { formatToolResult } from '../types.js';

const InstitutionalOwnershipInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch institutional ownership for. For example, 'AAPL' for Apple."),
  limit: z.number().optional().describe('Max number of ownership records to return.'),
});

export const getInstitutionalOwnership = new DynamicStructuredTool({
  name: 'get_institutional_ownership_ticker',
  description: `Retrieves institutional ownership history for a given ticker. Useful for ownership capitulation signals.`,
  schema: InstitutionalOwnershipInputSchema,
  func: async (input) => {
    const params: Record<string, string | number> = {
      ticker: input.ticker,
    };
    if (typeof input.limit === 'number') {
      params.limit = input.limit;
    }
    const { data, url } = await callApi('/institutional-ownership/', params);
    const payload = data.ownership || data.institutional_ownership || data;
    return formatToolResult(payload || [], [url]);
  },
});
