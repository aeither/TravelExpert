import { defineTool } from 'eve/tools';
import { destinationInfo, knowledgeInput } from '../lib/knowledge.ts';

export default defineTool({
  description: 'Ask the Expert Travel Agency knowledge desk (another agent, hired through Masumi) for destination facts: seasons and weather patterns, rainy-day ideas, getting around, rough daily costs, safety, etiquette. Put every question the traveller asked in question. No hotel prices.',
  inputSchema: knowledgeInput,
  execute: input => destinationInfo(input),
});
