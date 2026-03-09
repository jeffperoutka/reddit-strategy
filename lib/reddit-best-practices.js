const { askClaude, askClaudeLong, extractJson } = require('./connectors/claude');

const COMMENT_REVIEW_SYSTEM_PROMPT = `You are a Reddit authenticity and quality analyst. Your job is to review comments and posts intended for Reddit and score them against best practices for organic, high-quality engagement.

You evaluate TWO types of content:

## COMMENT BEST PRACTICES (score each dimension 1-10):

1. **Contextual Relevance (30% weight)**: Does the comment directly address the thread's discussion? Does it add value to what others are saying? Would removing it lose something from the conversation? A score of 10 means the comment is a natural, essential part of the discussion. A score of 1 means it's completely off-topic or generic.

2. **Community Fit (20% weight)**: Does the tone match the subreddit? r/technology has a different vibe than r/personalfinance or r/askreddit. Check for appropriate jargon, humor level, formality, and cultural norms. A tech subreddit expects technical depth. A casual subreddit expects wit.

3. **Thread Position (15% weight)**: Is this the right type of thread to comment in? High-engagement threads with active discussion are better targets. Dead threads with 0 comments look suspicious if a brand-adjacent comment appears. Consider thread age, engagement level, and whether the comment type fits the thread stage.

4. **Content Depth (15% weight)**: Real Reddit comments have substance. One-liners with a product link scream spam. Good comments share personal experience, nuance, honest pros AND cons, specific details. The best Reddit comments feel like talking to a knowledgeable friend, not reading ad copy.

5. **Account Credibility Signals (10% weight)**: Would this comment make sense coming from a relatively new account? Or does it require established posting history to be believable? Comments that reference deep subreddit history or claim expertise need account credibility to back them up.

6. **Anti-Detection (10% weight)**: Would moderators or savvy users flag this? Watch for: repeated brand-friendly phrases, too-perfect product mentions, lack of any criticism, astroturfing patterns (overly enthusiastic about a specific product without being asked), and language that reads like marketing copy rather than a real person.

## POST BEST PRACTICES (score each dimension 1-10):

1. **Subreddit Rule Compliance (25% weight)**: Does the post follow the subreddit's actual rules? Many subreddits ban self-promotion, require specific flairs, have title format requirements, or restrict certain content types. A post that violates rules gets removed instantly.

2. **Engagement Potential (25% weight)**: Will this post generate real discussion? Posts that ask interesting questions, present debatable opinions, or share genuinely useful information get engagement. Posts that feel like thinly-veiled ads die with 0 comments and get downvoted.

3. **Value-First Content (20% weight)**: The post must provide genuine value independent of any brand mention. A question that sparks real discussion, a guide that actually helps people, a resource list that's comprehensive and honest — not just a setup for a sales pitch.

4. **Brand Setup Quality (15% weight)**: How naturally can the brand be mentioned in a follow-up comment? The post itself shouldn't feel engineered for a brand mention. The best posts create organic opportunities where a brand mention in the comments feels helpful, not planted.

5. **Title Quality (15% weight)**: Reddit titles are everything. They must match subreddit conventions — not too clickbaity, not too boring, not too salesy. Check capitalization style, length, whether it asks a question vs makes a statement, and if it would actually make someone click.

## VERDICTS:
- **strong** (8-10): Ready to post with minimal changes
- **acceptable** (6-7.9): Usable but could be improved
- **weak** (4-5.9): Needs significant rework before posting
- **reject** (1-3.9): Would damage credibility, do not post

## OUTPUT FORMAT:
Return valid JSON matching this structure:
{
  "overall_score": <number 1-10>,
  "comment_reviews": [
    {
      "index": <number>,
      "score": <number 1-10>,
      "verdict": "strong|acceptable|weak|reject",
      "dimensions": {
        "contextual_relevance": { "score": <number>, "note": "<string>" },
        "community_fit": { "score": <number>, "note": "<string>" },
        "thread_position": { "score": <number>, "note": "<string>" },
        "content_depth": { "score": <number>, "note": "<string>" },
        "account_credibility": { "score": <number>, "note": "<string>" },
        "anti_detection": { "score": <number>, "note": "<string>" }
      },
      "improvements": ["<string>"]
    }
  ],
  "post_reviews": [
    {
      "index": <number>,
      "score": <number 1-10>,
      "verdict": "strong|acceptable|weak|reject",
      "dimensions": {
        "subreddit_compliance": { "score": <number>, "note": "<string>" },
        "engagement_potential": { "score": <number>, "note": "<string>" },
        "value_first": { "score": <number>, "note": "<string>" },
        "brand_setup": { "score": <number>, "note": "<string>" },
        "title_quality": { "score": <number>, "note": "<string>" }
      },
      "improvements": ["<string>"]
    }
  ],
  "top_issues": ["<string>"],
  "recommendations": ["<string>"]
}

Return ONLY the JSON object. No markdown fences, no commentary.`;

const CONTEXTUAL_RELEVANCE_SYSTEM_PROMPT = `You are a Reddit thread analyst. Given a comment and its thread context, score how well the comment fits into the specific conversation happening in that thread.

Score 1-10 based on:
1. Does the comment actually respond to what's being discussed in THIS thread?
2. Does it add information or perspective the thread doesn't already have?
3. Would a real person write this in response to THIS specific thread, or does it feel generic/dropped-in?

A score of 10 means the comment is a perfect, natural response that could only have been written by someone who read and understood the full thread.
A score of 1 means the comment is completely generic and could be pasted into any thread.

Return valid JSON:
{
  "score": <number 1-10>,
  "explanation": "<2-3 sentences explaining the score>",
  "feels_organic": <boolean>,
  "missing_context": "<what the comment should reference from the thread but doesn't, or null>"
}

Return ONLY the JSON object. No markdown fences, no commentary.`;

function cleanJsonResponse(text) {
  if (!text) return text;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.trim();
  return cleaned;
}

async function reviewRedditBestPractices(comments, posts, threadData) {
  try {
    const userPrompt = buildReviewPrompt(comments, posts, threadData);
    const response = await askClaudeLong(COMMENT_REVIEW_SYSTEM_PROMPT, userPrompt);

    const result = extractJson(response);
    return result;
  } catch (error) {
    console.error('Error in reviewRedditBestPractices:', error.message);
    return {
      overall_score: 0,
      comment_reviews: (comments || []).map((_, index) => ({
        index,
        score: 0,
        verdict: 'reject',
        dimensions: {
          contextual_relevance: { score: 0, note: 'Review failed' },
          community_fit: { score: 0, note: 'Review failed' },
          thread_position: { score: 0, note: 'Review failed' },
          content_depth: { score: 0, note: 'Review failed' },
          account_credibility: { score: 0, note: 'Review failed' },
          anti_detection: { score: 0, note: 'Review failed' },
        },
        improvements: ['Review could not be completed — retry'],
      })),
      post_reviews: (posts || []).map((_, index) => ({
        index,
        score: 0,
        verdict: 'reject',
        dimensions: {
          subreddit_compliance: { score: 0, note: 'Review failed' },
          engagement_potential: { score: 0, note: 'Review failed' },
          value_first: { score: 0, note: 'Review failed' },
          brand_setup: { score: 0, note: 'Review failed' },
          title_quality: { score: 0, note: 'Review failed' },
        },
        improvements: ['Review could not be completed — retry'],
      })),
      top_issues: ['Review failed due to an error: ' + error.message],
      recommendations: ['Retry the review'],
    };
  }
}

function buildReviewPrompt(comments, posts, threadData) {
  const parts = [];

  if (threadData) {
    parts.push('## THREAD CONTEXT');
    if (threadData.subreddit) parts.push(`Subreddit: r/${threadData.subreddit}`);
    if (threadData.title) parts.push(`Thread Title: ${threadData.title}`);
    if (threadData.body) parts.push(`Thread Body: ${threadData.body}`);
    if (threadData.score !== undefined) parts.push(`Thread Score: ${threadData.score}`);
    if (threadData.num_comments !== undefined) parts.push(`Comment Count: ${threadData.num_comments}`);
    if (threadData.age) parts.push(`Thread Age: ${threadData.age}`);
    if (threadData.existing_comments && threadData.existing_comments.length > 0) {
      parts.push('\nExisting Comments in Thread:');
      threadData.existing_comments.forEach((c, i) => {
        parts.push(`  [${i}] (score: ${c.score || '?'}): ${c.body || c.text || ''}`);
      });
    }
    if (threadData.subreddit_rules) {
      parts.push(`\nSubreddit Rules: ${threadData.subreddit_rules}`);
    }
    parts.push('');
  }

  if (comments && comments.length > 0) {
    parts.push('## COMMENTS TO REVIEW');
    comments.forEach((comment, i) => {
      parts.push(`\n### Comment ${i}`);
      if (comment.target_subreddit) parts.push(`Target Subreddit: r/${comment.target_subreddit}`);
      if (comment.thread_title) parts.push(`Thread Title: ${comment.thread_title}`);
      parts.push(`Comment Text: ${comment.text || comment.body || comment.content || ''}`);
      if (comment.brand_mention) parts.push(`Brand Mentioned: ${comment.brand_mention}`);
    });
    parts.push('');
  }

  if (posts && posts.length > 0) {
    parts.push('## POSTS TO REVIEW');
    posts.forEach((post, i) => {
      parts.push(`\n### Post ${i}`);
      if (post.target_subreddit) parts.push(`Target Subreddit: r/${post.target_subreddit}`);
      if (post.title) parts.push(`Title: ${post.title}`);
      parts.push(`Body: ${post.text || post.body || post.content || ''}`);
      if (post.brand_mention) parts.push(`Brand Mentioned: ${post.brand_mention}`);
      if (post.followup_comment) parts.push(`Planned Follow-up Comment: ${post.followup_comment}`);
    });
    parts.push('');
  }

  parts.push('Review all content above against Reddit best practices. Return the JSON review object.');
  return parts.join('\n');
}

async function scoreContextualRelevance(comment, threadContext) {
  try {
    const userPrompt = buildContextualRelevancePrompt(comment, threadContext);
    const response = await askClaude(CONTEXTUAL_RELEVANCE_SYSTEM_PROMPT, userPrompt);

    const result = extractJson(response);
    return result;
  } catch (error) {
    console.error('Error in scoreContextualRelevance:', error.message);
    return {
      score: 0,
      explanation: 'Scoring failed due to an error: ' + error.message,
      feels_organic: false,
      missing_context: null,
    };
  }
}

function buildContextualRelevancePrompt(comment, threadContext) {
  const parts = [];

  parts.push('## THREAD CONTEXT');
  if (threadContext.subreddit) parts.push(`Subreddit: r/${threadContext.subreddit}`);
  if (threadContext.title) parts.push(`Thread Title: ${threadContext.title}`);
  if (threadContext.body) parts.push(`Thread Body: ${threadContext.body}`);
  if (threadContext.existing_comments && threadContext.existing_comments.length > 0) {
    parts.push('\nExisting Comments:');
    threadContext.existing_comments.forEach((c, i) => {
      parts.push(`  [${i}] (score: ${c.score || '?'}): ${c.body || c.text || ''}`);
    });
  }

  parts.push('\n## COMMENT TO SCORE');
  parts.push(comment.text || comment.body || comment.content || '');

  parts.push('\nScore how well this comment fits into this specific thread context.');
  return parts.join('\n');
}

module.exports = {
  reviewRedditBestPractices,
  scoreContextualRelevance,
};
