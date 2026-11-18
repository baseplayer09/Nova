import { createVercelHandler } from '../src/vercel-handler.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default createVercelHandler();
