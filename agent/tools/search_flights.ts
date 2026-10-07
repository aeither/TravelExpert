import { defineTool } from 'eve/tools';
import { flightInput, searchFlights } from '../lib/flights.ts';

export default defineTool({
  description: 'Search flight fares through the Expert Travel Agency (paid hop). Only when the traveller named a departure city; never guess the origin. Test-environment fares, indicative only.',
  inputSchema: flightInput,
  execute: input => searchFlights(input),
});
