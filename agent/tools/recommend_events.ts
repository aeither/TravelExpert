import { defineTool } from 'eve/tools';
import { recommendEvents, recommendationInput } from '../../src/recommendations.mjs';

export default defineTool({
  description: 'Find source-backed TOKEN2049 Singapore 2026 conference talks and side events. Return a schedule, conflicts, admission limits, and source URLs. Times use Singapore time.',
  inputSchema: recommendationInput,
  async execute(input) {
    return recommendEvents(input);
  },
});
