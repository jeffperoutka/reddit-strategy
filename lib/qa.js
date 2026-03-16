/**
 * QA Engine — Automated Quality Assurance for Reddit Strategy Bot
 *
 * Runs after the deliverable is built. Claude reviews every comment and post
 * for brand alignment, Reddit best practices, contextual fit, and scope compliance.
 *
 * Flow: Review all items → Flag issues → Regenerate flagged items → Return revised data
 */

const { askClaudeLong, extractJson } = require('./connectors/claude');
const { getPackage } = require('./packages');

/**
 * Run full QA on generated content. Returns revised data + QA report.
 *
 * @param {object} strategyData - Full pipeline output (commentsWithAlignment, posts, upvotePlan)
 * @param {object} brandProfile - Brand profile
 * @param {string} packageTier - Package tier key
 * @returns {{ revisedComments, revisedPosts, qaReport, flaggedCount, revisedCount }}
 */
async function runQA(strategyData, brandProfile, packageTier) {
  const pkg = getPackage(packageTier);
  const comments = strategyData.commentsWithAlignment || [];
  const posts = strategyData.posts || [];

  console.log(`[QA] Starting QA review: ${comments.length} comments, ${posts.length} posts`);

  // ── Step 1: Review all content in parallel batches ──
  const REVIEW_BATCH = 10;
  const [commentFlags, postFlags] = await Promise.all([
    reviewComments(comments, brandProfile, REVIEW_BATCH),
    reviewPosts(posts, brandProfile, REVIEW_BATCH),
  ]);

  const flaggedComments = commentFlags.filter(f => !f.pass);
  const flaggedPosts = postFlags.filter(f => !f.pass);
  console.log(`[QA] Flagged: ${flaggedComments.length}/${comments.length} comments, ${flaggedPosts.length}/${posts.length} posts`);

  // ── Step 2: Scope verification ──
  const scopeIssues = verifyScopeCompliance(comments, posts, strategyData.upvotePlan, pkg);

  // ── Step 3: Regenerate flagged items ──
  let revisedComments = [...comments];
  let revisedPosts = [...posts];
  let revisedCount = 0;

  if (flaggedComments.length > 0) {
    const regenerated = await regenerateComments(
      flaggedComments, comments, brandProfile, packageTier
    );
    // Replace flagged comments with regenerated ones
    for (const regen of regenerated) {
      if (regen.originalIndex != null && regen.originalIndex < revisedComments.length) {
        revisedComments[regen.originalIndex] = {
          ...revisedComments[regen.originalIndex],
          comment: regen.comment,
          angle: regen.angle || revisedComments[regen.originalIndex].angle,
          brandMentionType: regen.brandMentionType || revisedComments[regen.originalIndex].brandMentionType,
          _qaRevised: true,
          _qaReason: regen.reason,
        };
        revisedCount++;
      }
    }
  }

  if (flaggedPosts.length > 0) {
    const regenerated = await regeneratePosts(
      flaggedPosts, posts, brandProfile, packageTier
    );
    for (const regen of regenerated) {
      if (regen.originalIndex != null && regen.originalIndex < revisedPosts.length) {
        revisedPosts[regen.originalIndex] = {
          ...revisedPosts[regen.originalIndex],
          title: regen.title || revisedPosts[regen.originalIndex].title,
          body: regen.body || revisedPosts[regen.originalIndex].body,
          followUpComment: regen.followUpComment || revisedPosts[regen.originalIndex].followUpComment,
          brandMentionStrategy: regen.brandMentionStrategy || revisedPosts[regen.originalIndex].brandMentionStrategy,
          _qaRevised: true,
          _qaReason: regen.reason,
        };
        revisedCount++;
      }
    }
  }

  // ── Build QA report ──
  const qaReport = {
    totalReviewed: comments.length + posts.length,
    commentsFlagged: flaggedComments.length,
    postsFlagged: flaggedPosts.length,
    itemsRevised: revisedCount,
    scopeIssues,
    commentIssues: flaggedComments.map(f => ({
      index: f.index,
      issues: f.issues,
      subreddit: comments[f.index]?.subreddit,
    })),
    postIssues: flaggedPosts.map(f => ({
      index: f.index,
      issues: f.issues,
      subreddit: posts[f.index]?.subreddit,
    })),
    passed: flaggedComments.length === 0 && flaggedPosts.length === 0 && scopeIssues.length === 0,
  };

  console.log(`[QA] Complete: ${revisedCount} items revised, ${scopeIssues.length} scope issues`);

  return {
    revisedComments,
    revisedPosts,
    qaReport,
    flaggedCount: flaggedComments.length + flaggedPosts.length,
    revisedCount,
  };
}

// ── Comment Review ──

async function reviewComments(comments, brandProfile, batchSize) {
  if (comments.length === 0) return [];

  const batches = [];
  for (let i = 0; i < comments.length; i += batchSize) {
    batches.push(comments.slice(i, i + batchSize).map((c, j) => ({ ...c, _idx: i + j })));
  }

  const results = await Promise.all(batches.map(batch => reviewCommentBatch(batch, brandProfile)));
  return results.flat();
}

async function reviewCommentBatch(batch, brandProfile) {
  const brandName = brandProfile.clientName;

  const commentList = batch.map((c, i) => (
    `[${i}] Subreddit: ${c.subreddit} | Thread: ${c.threadTitle}\nComment: ${c.comment}\nAngle: ${c.angle} | Brand Mention: ${c.brandMentionType}`
  )).join('\n\n---\n\n');

  try {
    const response = await askClaudeLong(
      `You are a QA reviewer for Reddit marketing content. Review each comment against these criteria:

1. BRAND MENTION: The brand "${brandName}" must be mentioned at least once. No brand mention = automatic fail.
2. AUTHENTICITY: Must read like a real Reddit user, not a marketer. No corporate jargon, superlatives ("game-changer", "revolutionary", "best ever"), or unnatural enthusiasm.
3. SUBREDDIT FIT: Tone must match the target subreddit's culture.
4. LENGTH: 2-6 sentences. Too short or too long = flag.
5. THIRD PERSON: Must use "I tried X" / "I switched to X". Never "we" or insider language.
6. CONTEXTUAL: Must reference the thread topic directly, not be a generic brand plug.
7. SPAM SIGNALS: No repetitive phrasing, no obvious shill patterns, no identical brand mention format across comments.

For each comment, output PASS or FAIL with specific issues.

Return JSON:
{
  "reviews": [
    { "index": 0, "pass": true, "issues": [] },
    { "index": 1, "pass": false, "issues": ["No brand mention", "Reads like marketing copy"] }
  ]
}`,
      `Brand: ${brandName}\n\nReview these ${batch.length} comments:\n\n${commentList}`,
      { maxTokens: 4000, timeout: 120000 }
    );

    const parsed = extractJson(response);
    return (parsed.reviews || []).map(r => ({
      index: batch[r.index]?._idx ?? r.index,
      pass: r.pass,
      issues: r.issues || [],
    }));
  } catch (err) {
    console.error('[QA] Comment review batch failed:', err.message);
    // On failure, pass all (don't block the pipeline)
    return batch.map(c => ({ index: c._idx, pass: true, issues: [] }));
  }
}

// ── Post Review ──

async function reviewPosts(posts, brandProfile, batchSize) {
  if (posts.length === 0) return [];

  const batches = [];
  for (let i = 0; i < posts.length; i += batchSize) {
    batches.push(posts.slice(i, i + batchSize).map((p, j) => ({ ...p, _idx: i + j })));
  }

  const results = await Promise.all(batches.map(batch => reviewPostBatch(batch, brandProfile)));
  return results.flat();
}

async function reviewPostBatch(batch, brandProfile) {
  const brandName = brandProfile.clientName;

  const postList = batch.map((p, i) => (
    `[${i}] Subreddit: ${p.subreddit} | Type: ${p.postType}\nTitle: ${p.title}\nBody: ${p.body}\nFollow-Up Comment: ${p.followUpComment || 'MISSING'}\nBrand Strategy: ${p.brandMentionStrategy || 'MISSING'}`
  )).join('\n\n---\n\n');

  try {
    const response = await askClaudeLong(
      `You are a QA reviewer for Reddit marketing content. Review each POST against these criteria:

1. NO DIRECT BRAND MENTION: The post title and body must NOT mention "${brandName}" directly. Posts set up opportunities for follow-up comments. Direct brand mention in the post = automatic fail.
2. FOLLOW-UP COMMENT: Must be present and must mention the brand by name. Missing = fail.
3. BRAND STRATEGY: Must explain how the brand will be mentioned naturally. Missing = fail.
4. SUBREDDIT FIT: Title must feel native to the target subreddit.
5. VALUE: Post must provide genuine value — asks a real question, shares useful info, or sparks discussion.
6. VARIETY: Flag if post type or angle is too similar to others in the batch.
7. ENGAGEMENT: Title should invite discussion, not be clickbait or generic.

For each post, output PASS or FAIL with specific issues.

Return JSON:
{
  "reviews": [
    { "index": 0, "pass": true, "issues": [] },
    { "index": 1, "pass": false, "issues": ["Brand mentioned directly in post body", "Follow-up comment missing"] }
  ]
}`,
      `Brand: ${brandName}\n\nReview these ${batch.length} posts:\n\n${postList}`,
      { maxTokens: 4000, timeout: 120000 }
    );

    const parsed = extractJson(response);
    return (parsed.reviews || []).map(r => ({
      index: batch[r.index]?._idx ?? r.index,
      pass: r.pass,
      issues: r.issues || [],
    }));
  } catch (err) {
    console.error('[QA] Post review batch failed:', err.message);
    return batch.map(p => ({ index: p._idx, pass: true, issues: [] }));
  }
}

// ── Scope Compliance ──

function verifyScopeCompliance(comments, posts, upvotePlan, pkg) {
  const issues = [];
  if (!pkg) return issues;

  const targetComments = pkg.monthlyTargets?.comments || 0;
  const targetPosts = pkg.monthlyTargets?.posts || 0;
  const targetUpvotes = pkg.monthlyTargets?.upvotes || 0;

  if (comments.length < targetComments) {
    issues.push(`Comments short: ${comments.length}/${targetComments}`);
  }
  if (posts.length < targetPosts) {
    issues.push(`Posts short: ${posts.length}/${targetPosts}`);
  }
  if (upvotePlan?.totalUpvotes != null && upvotePlan.totalUpvotes < targetUpvotes * 0.8) {
    issues.push(`Upvotes low: ${upvotePlan.totalUpvotes}/${targetUpvotes}`);
  }

  // Check for duplicate subreddits in posts (more than 3 posts to same sub)
  const postSubCounts = {};
  for (const p of posts) {
    const sub = (p.subreddit || '').toLowerCase();
    postSubCounts[sub] = (postSubCounts[sub] || 0) + 1;
  }
  for (const [sub, count] of Object.entries(postSubCounts)) {
    if (count > 3) {
      issues.push(`Post concentration: ${count} posts in ${sub} (max 3 recommended)`);
    }
  }

  return issues;
}

// ── Regeneration ──

async function regenerateComments(flaggedComments, allComments, brandProfile, packageTier) {
  const brandName = brandProfile.clientName;
  const flaggedDetails = flaggedComments.map(f => {
    const original = allComments[f.index];
    return {
      originalIndex: f.index,
      subreddit: original?.subreddit,
      threadTitle: original?.threadTitle,
      threadUrl: original?.threadUrl,
      issues: f.issues,
      originalComment: original?.comment,
    };
  });

  try {
    const response = await askClaudeLong(
      `You are rewriting Reddit comments that failed QA. Fix ONLY the flagged issues while preserving the original intent.

BRAND: ${brandName}
Products: ${(brandProfile.coreOfferings?.products || []).join(', ')}
Voice: ${brandProfile.brandVoice?.tone || 'Casual, helpful'}

RULES:
- Every comment MUST mention the brand at least once
- Must read like a real Reddit user, not a marketer
- 2-6 sentences, casual tone, third person ("I tried X")
- Reference the thread topic directly
- No superlatives, no corporate speak

Return JSON:
{
  "revised": [
    {
      "originalIndex": 0,
      "comment": "The rewritten comment text",
      "angle": "approach taken",
      "brandMentionType": "direct|indirect|contextual",
      "reason": "What was fixed"
    }
  ]
}`,
      `Rewrite these ${flaggedDetails.length} flagged comments:\n\n${JSON.stringify(flaggedDetails, null, 2)}`,
      { maxTokens: 8000, timeout: 120000 }
    );

    const parsed = extractJson(response);
    return parsed.revised || [];
  } catch (err) {
    console.error('[QA] Comment regeneration failed:', err.message);
    return [];
  }
}

async function regeneratePosts(flaggedPosts, allPosts, brandProfile, packageTier) {
  const brandName = brandProfile.clientName;
  const flaggedDetails = flaggedPosts.map(f => {
    const original = allPosts[f.index];
    return {
      originalIndex: f.index,
      subreddit: original?.subreddit,
      postType: original?.postType,
      issues: f.issues,
      originalTitle: original?.title,
      originalBody: original?.body,
    };
  });

  try {
    const response = await askClaudeLong(
      `You are rewriting Reddit posts that failed QA. Fix ONLY the flagged issues.

BRAND: ${brandName} (do NOT mention in post title or body — only in follow-up comment)

RULES:
- Post must NOT mention the brand directly
- Must provide genuine value to the subreddit
- Title must feel native to the subreddit
- Follow-up comment MUST mention the brand by name
- Include brand mention strategy

Return JSON:
{
  "revised": [
    {
      "originalIndex": 0,
      "title": "Revised post title",
      "body": "Revised post body",
      "followUpComment": "The follow-up comment mentioning the brand",
      "brandMentionStrategy": "How the brand is introduced",
      "reason": "What was fixed"
    }
  ]
}`,
      `Rewrite these ${flaggedDetails.length} flagged posts:\n\n${JSON.stringify(flaggedDetails, null, 2)}`,
      { maxTokens: 8000, timeout: 120000 }
    );

    const parsed = extractJson(response);
    return parsed.revised || [];
  } catch (err) {
    console.error('[QA] Post regeneration failed:', err.message);
    return [];
  }
}

module.exports = { runQA };
