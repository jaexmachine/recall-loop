import { handleAiRequest } from '../server/ai-handler.mjs';

export default {
  async fetch(request: Request) {
    return handleAiRequest(request);
  },
};
