/**
 * Test endpoint — validate a Reddit thread URL.
 * GET /api/test/validate-thread?url=https://reddit.com/r/SEO/comments/...
 *
 * Temporary — remove after confirming the validator works on Vercel.
 */
const { validateThread } = require('../../lib/reddit-validator');

module.exports = async function handler(req, res) {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const result = await validateThread(url);
  res.status(200).json(result);
};
