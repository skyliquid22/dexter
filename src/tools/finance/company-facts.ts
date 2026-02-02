import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callApi } from './api.js';
import { formatToolResult } from '../types.js';

const CompanyFactsInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch company facts for. For example, 'AAPL' for Apple."),
});

export const getCompanyFacts = new DynamicStructuredTool({
  name: 'get_company_facts',
  description: `Retrieves company facts for a given ticker, including sector, industry, and basic identifiers. Useful for peer/sector mapping.`,
  schema: CompanyFactsInputSchema,
  func: async (input) => {
    const params: Record<string, string> = {
      ticker: input.ticker,
    };
    const { data, url } = await callApi('/company/facts/', params);
    return formatToolResult(data.company_facts || data, [url]);
  },
});
