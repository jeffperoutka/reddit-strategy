/**
 * Content Sanitization — strips AI tells from generated content.
 *
 * Applied programmatically AFTER generation so we don't rely on the AI
 * model to follow the rules perfectly every time.
 */

// Banned phrases that scream "AI wrote this"
const BANNED_PHRASES = [
  'game-changer', 'game changer',
  'I stumbled upon', 'I recently discovered',
  'blown away', "can't recommend enough",
  'highly recommend', 'I was pleasantly surprised',
  'take it to the next level', 'worth every penny',
  'hands down', 'not gonna lie',
  "if you're looking for",
];

/**
 * Sanitize a single string: remove em dashes, en dashes, double hyphens, semicolons.
 */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return text;

  let result = text;

  // Replace em dash (—) with comma or rewrite
  result = result.replace(/\s*—\s*/g, ', ');
  // Replace en dash (–) used as em dash
  result = result.replace(/\s*–\s*/g, ', ');
  // Replace double hyphens used as em dash ( -- )
  result = result.replace(/\s+--\s+/g, ', ');
  // Replace semicolons with period + space (new sentence)
  result = result.replace(/;\s*/g, '. ');
  // Clean up double commas or comma-period combos
  result = result.replace(/,\s*,/g, ',');
  result = result.replace(/,\s*\./g, '.');
  result = result.replace(/\.\s*\./g, '.');
  // Fix capitalization after period replacements
  result = result.replace(/\.\s+([a-z])/g, (_, c) => '. ' + c.toUpperCase());

  return result;
}

/**
 * Sanitize a comment object — cleans the comment text.
 */
function sanitizeComment(comment) {
  if (!comment) return comment;
  return {
    ...comment,
    comment: sanitizeText(comment.comment),
    notes: sanitizeText(comment.notes),
  };
}

/**
 * Sanitize a post object — cleans title, body, follow-up comment.
 */
function sanitizePost(post) {
  if (!post) return post;
  return {
    ...post,
    title: sanitizeText(post.title),
    body: sanitizeText(post.body),
    followUpComment: sanitizeText(post.followUpComment),
    brandMentionStrategy: sanitizeText(post.brandMentionStrategy),
  };
}

/**
 * Sanitize all content in a result set.
 * Works on { comments: [...] } or { posts: [...] } shapes.
 */
function sanitizeContent(data) {
  if (!data) return data;

  if (Array.isArray(data.comments)) {
    data.comments = data.comments.map(sanitizeComment);
  }
  if (Array.isArray(data.posts)) {
    data.posts = data.posts.map(sanitizePost);
  }
  return data;
}

/**
 * Check a string for remaining AI tells. Returns array of issues found.
 */
function detectAITells(text) {
  if (!text || typeof text !== 'string') return [];
  const issues = [];

  if (/\u2014/.test(text)) issues.push('Contains em dash (—)');
  if (/\u2013/.test(text)) issues.push('Contains en dash (–)');
  if (/\s--\s/.test(text)) issues.push('Contains double hyphen (--)');
  if (/;/.test(text)) issues.push('Contains semicolon');

  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) {
      issues.push(`Contains banned phrase: "${phrase}"`);
    }
  }

  return issues;
}

module.exports = { sanitizeText, sanitizeComment, sanitizePost, sanitizeContent, detectAITells };
