import { defineAgent } from 'eve';
import { zai } from './lib/models.mjs';

export default defineAgent({ model: zai('glm-5.3-flash'), defaultTools: false });
