import { readFileSync } from 'node:fs';
import { recommendEvents, formatRecommendations } from '../src/recommendations.mjs';

try {
  const arg = process.argv[2];
  if (!arg) throw new Error('Usage: npm run recommend -- examples/request.json [--json]');
  const input = JSON.parse(arg.startsWith('{') ? arg : readFileSync(arg, 'utf8'));
  const result = recommendEvents(input);
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : formatRecommendations(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
