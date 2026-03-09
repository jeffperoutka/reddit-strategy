const { askClaudeLong, extractJson } = require('./connectors/claude');

const REDDIT_SCORECARD_PROMPT = `You are a brand-alignment reviewer for Reddit content. You evaluate drafted Reddit comments and posts against a client's brand profile to ensure they sound authentic, non-promotional, and accurate.

## Scoring Dimensions

1. **Authenticity (25%)** — Does this sound like a real Reddit user? Natural language, appropriate tone for the subreddit, no corporate speak.
2. **Promotional Temperature (25%)** — Zero promotional feel. The comment should read as genuine advice or discussion, never as an ad.
3. **Product Accuracy (15%)** — Any factual claims about the client's product/service must be correct.
4. **Natural Mention (15%)** — If the client is mentioned, it flows naturally within the context of the conversation.
5. **Perspective Consistency (10%)** — Maintains a third-party perspective. Speaks as a user/customer, never as the company.
6. **Sensitivity & Scope (10%)** — Mentions correct products only, avoids flagged topics, respects subreddit norms.

## Red Flags (Auto-Fail — score 0 for the item)

- Uses "we" when referring to the client (e.g., "we offer", "our product")
- Uses marketing phrases: "industry-leading", "best-in-class", "cutting-edge", "game-changer", "revolutionary", "world-class", "state-of-the-art"
- URL appears in the first sentence
- Comment is entirely about the client with no broader context or value
- Uses the client's exact brand tagline verbatim

## Verdicts

- **aligned** (score 7-10): Content is safe to post as-is or with minor tweaks
- **drift** (score 4-6): Content needs revision before posting — tone or framing issues
- **misaligned** (score 0-3): Content should not be posted — rewrite required

## Output Format

Return a JSON object with this exact structure:
{
  "status": "success",
  "client": "<client_name>",
  "content_type": "reddit",
  "overall_score": <number 0-10>,
  "total_items_reviewed": <number>,
  "score_distribution": { "aligned": <n>, "drift": <n>, "misaligned": <n>, "inferred": <n> },
  "top_issues": ["<string>", ...],
  "data_gaps": ["<string>", ...],
  "row_reviews": [
    {
      "row": <row_number>,
      "overall_score": <number 0-10>,
      "verdict": "aligned | drift | misaligned",
      "flags": [
        {
          "type": "flag_emoji_and_label",
          "dimension": "<dimension_name>",
          "issue": "<what's wrong>",
          "evidence": "<quote from the content>",
          "suggestion": "<how to fix>"
        }
      ]
    }
  ]
}

Flag types:
- "🟢 ALIGNED" — dimension passes
- "🟡 DRIFT" — dimension has minor issues
- "🔴 MISALIGNED" — dimension fails
- "⚪ INFERRED" — not enough data to evaluate, score inferred

Return ONLY valid JSON. No markdown fences, no explanation outside the JSON.`;

/**
 * Formats comment and post data into the brand-alignment skill's input schema.
 */
function prepareBrandAlignmentInput(comments, posts, clientName) {
  const contentData = [];
  let rowIndex = 2; // starts at 2 per skill convention (row 1 = header)

  if (comments && Array.isArray(comments)) {
    for (const comment of comments) {
      contentData.push({
        row: rowIndex++,
        fields: {
          draft: comment.comment_text || comment.draft || comment.text || '',
          topic: comment.thread_title || comment.title || comment.topic || '',
          keyword: comment.target_keyword || comment.keyword || '',
          url: comment.thread_url || comment.url || ''
        }
      });
    }
  }

  if (posts && Array.isArray(posts)) {
    for (const post of posts) {
      contentData.push({
        row: rowIndex++,
        fields: {
          draft: post.post_text || post.body || post.draft || '',
          topic: post.title || post.topic || '',
          keyword: post.target_keyword || post.keyword || '',
          url: post.url || ''
        }
      });
    }
  }

  return {
    action: 'review_brand_alignment',
    client_name: clientName,
    content_type: 'reddit',
    content_data: contentData,
    column_map: {
      draft: 'comment_text',
      topic: 'thread_title',
      url: 'thread_url',
      keyword: 'target_keyword'
    }
  };
}

/**
 * Runs the brand alignment review using Claude.
 */
async function runBrandAlignmentReview(contentData, clientName, contentType = 'reddit', brandProfile = null) {
  const brandContext = brandProfile
    ? `\n\n## Brand Profile for ${clientName}\n${typeof brandProfile === 'string' ? brandProfile : JSON.stringify(brandProfile, null, 2)}`
    : '';

  const systemPrompt = REDDIT_SCORECARD_PROMPT + brandContext;

  const userPrompt = `Review the following ${contentType} content for brand alignment with "${clientName}".

${JSON.stringify(contentData, null, 2)}

Evaluate every item against all 6 dimensions. Check for all red flags. Return the full JSON result.`;

  try {
    const raw = await askClaudeLong(systemPrompt, userPrompt);

    const result = extractJson(raw);
    return result;
  } catch (err) {
    console.error('[brand-alignment] Review failed:', err.message);

    // Return sensible defaults on failure
    const itemCount = Array.isArray(contentData)
      ? contentData.length
      : (contentData.content_data || []).length;

    return {
      status: 'error',
      client: clientName,
      content_type: contentType,
      overall_score: 0,
      total_items_reviewed: itemCount,
      score_distribution: { aligned: 0, drift: 0, misaligned: 0, inferred: itemCount },
      top_issues: [`Review failed: ${err.message}`],
      data_gaps: ['Could not perform alignment review — all items marked as inferred'],
      row_reviews: []
    };
  }
}

/**
 * Merges alignment results back into strategy data.
 * Adds alignment_score, alignment_verdict, and alignment_flags to each item.
 */
function writeBrandAlignmentOutput(strategyData, alignmentResult) {
  if (!alignmentResult || alignmentResult.status === 'error') {
    return {
      ...strategyData,
      brand_alignment: {
        status: 'error',
        overall_score: 0,
        message: alignmentResult?.top_issues?.[0] || 'Alignment review not available'
      }
    };
  }

  // Build a lookup of row reviews by row number
  const reviewsByRow = {};
  if (alignmentResult.row_reviews) {
    for (const review of alignmentResult.row_reviews) {
      reviewsByRow[review.row] = review;
    }
  }

  // Merge into strategy items (comments and posts)
  const mergeItems = (items) => {
    if (!items || !Array.isArray(items)) return items;
    return items.map((item, idx) => {
      const rowNum = item._alignment_row || (idx + 2);
      const review = reviewsByRow[rowNum];
      if (!review) return item;

      return {
        ...item,
        alignment_score: review.overall_score,
        alignment_verdict: review.verdict,
        alignment_flags: review.flags || []
      };
    });
  };

  return {
    ...strategyData,
    comments: mergeItems(strategyData.comments),
    posts: mergeItems(strategyData.posts),
    brand_alignment: {
      status: alignmentResult.status,
      overall_score: alignmentResult.overall_score,
      total_items_reviewed: alignmentResult.total_items_reviewed,
      score_distribution: alignmentResult.score_distribution,
      top_issues: alignmentResult.top_issues || [],
      data_gaps: alignmentResult.data_gaps || []
    }
  };
}

module.exports = {
  prepareBrandAlignmentInput,
  runBrandAlignmentReview,
  writeBrandAlignmentOutput
};
