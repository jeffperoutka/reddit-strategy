const Anthropic = require('@anthropic-ai/sdk');

function withTimeout(promise, ms, label = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function askClaude(systemPrompt, userContent, options = {}) {
  const anthropic = new Anthropic();
  const response = await withTimeout(
    anthropic.messages.create({
      model: options.model || 'claude-sonnet-4-5-20250929',
      max_tokens: options.maxTokens || 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
    options.timeout || 90000,
    'Claude API'
  );
  return response.content[0].text;
}

async function askClaudeLong(systemPrompt, userContent, options = {}) {
  const anthropic = new Anthropic();
  const stream = await withTimeout(
    anthropic.messages.stream({
      model: options.model || 'claude-sonnet-4-5-20250929',
      max_tokens: options.maxTokens || 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
    options.timeout || 180000,
    'Claude Stream'
  );
  const response = await stream.finalMessage();
  return response.content[0].text;
}

/**
 * Robustly extract JSON from a Claude response that may contain
 * markdown fences, leading text, trailing commentary, or truncation.
 */
function extractJson(text) {
  if (!text) throw new Error('Empty response from Claude');
  let cleaned = text.trim();

  // Strip markdown fences (single or multiple)
  cleaned = cleaned.replace(/```(?:json)?\s*/gi, '').replace(/\s*```/gi, '');
  cleaned = cleaned.trim();

  // If it starts with { or [, try parsing directly
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }
  }

  // Find the first { or [ and last } or ]
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let start = -1;
  let end = -1;
  let opener = '{';
  let closer = '}';

  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) {
    start = firstBrace;
    end = cleaned.lastIndexOf('}');
  } else if (firstBracket >= 0) {
    start = firstBracket;
    end = cleaned.lastIndexOf(']');
    opener = '[';
    closer = ']';
  }

  // Use the candidate between first/last matching braces, or from first brace to end if truncated
  if (start >= 0) {
    const candidate = end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
    try { return JSON.parse(candidate); } catch (e) { /* fall through to repair */ }

    // Attempt repair: truncated JSON (hit max_tokens)
    try {
      const repaired = repairTruncatedJson(candidate);
      return JSON.parse(repaired);
    } catch (e2) { /* fall through */ }
  }

  throw new Error(`Could not extract JSON from response: ${cleaned.slice(0, 200)}`);
}

/**
 * Attempt to repair truncated JSON by closing open strings, brackets, and braces
 * in the correct nesting order.
 */
function repairTruncatedJson(text) {
  let repaired = text;

  // Check if we're inside an unclosed string
  let quoteCount = 0;
  let escaped = false;
  for (let i = 0; i < repaired.length; i++) {
    if (escaped) { escaped = false; continue; }
    if (repaired[i] === '\\') { escaped = true; continue; }
    if (repaired[i] === '"') quoteCount++;
  }
  if (quoteCount % 2 !== 0) {
    repaired += '"';
  }

  // Remove trailing comma or partial key-value
  repaired = repaired.replace(/,\s*$/, '');
  repaired = repaired.replace(/,\s*"[^"]*"\s*:\s*$/, '');

  // Use a stack to track nesting order, then close in reverse
  const stack = [];
  let inString = false;
  escaped = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  // Close in reverse nesting order
  while (stack.length > 0) {
    repaired += stack.pop();
  }

  return repaired;
}

module.exports = { askClaude, askClaudeLong, withTimeout, extractJson };
