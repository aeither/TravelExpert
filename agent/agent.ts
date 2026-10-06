import { defineAgent } from 'eve';
import { openrouter, MODEL_ID } from './lib/models.mjs';

// openrouter/free routes to a free model per request, so no catalog lists its context window; 128k is the common floor.
export default defineAgent({ model: openrouter(MODEL_ID()), modelContextWindowTokens: 128_000, defaultTools: false });
