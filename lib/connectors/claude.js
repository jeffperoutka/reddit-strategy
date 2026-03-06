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

module.exports = { askClaude, askClaudeLong, withTimeout };
