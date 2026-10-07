import { defineTool } from 'eve/tools';
import { searchHotels, searchInput } from '../lib/hotels.ts';

export default defineTool({
  description: 'Search hotels for a city and dates through the Expert Travel Agency API (a paid agent-to-agent hop). Pass the children ages and the nightly budget when the traveller gave them: the code enforces the budget and family rules. Returns up to 8 ranked hotels with total prices, ratings, review highlights and whether each can be booked.',
  inputSchema: searchInput,
  execute: input => searchHotels(input),
});
