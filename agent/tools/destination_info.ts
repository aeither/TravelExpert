import { defineTool } from 'eve/tools';
import { destinationInfo, knowledgeInput } from '../lib/knowledge.ts';

export default defineTool({
  description: 'Ask the Expert Travel Agency knowledge desk (another agent) for general destination facts: best time to visit, getting around, rough daily costs, safety, etiquette. No hotel prices.',
  inputSchema: knowledgeInput,
  execute: input => destinationInfo(input),
});
