import { defineTool } from 'eve/tools';
import { searchHotels, searchInput } from '../lib/hotels.ts';

export default defineTool({
  description: 'Search pay-at-property hotels for a city and dates through the Expert Travel Agency API. Returns up to 8 hotels with total prices and a hotel page link.',
  inputSchema: searchInput,
  execute: input => searchHotels(input),
});
