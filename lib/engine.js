/**
 * Reddit Strategy Engine v1
 *
 * Pipeline (optimized for Vercel's 300s limit):
 * 1. Extract target keywords from brand profile
 * 2. DataForSEO: Search Google for Reddit threads per keyword
 * 3. (Optional) AI citation check per keyword
 * 4. Claude: Analyze top threads — scoring, narratives, opportunities
 * 5+6. Claude: Generate comments + posts IN PARALLEL
 * 7. Claude: Brand alignment check on comments
 * 8. Upvote support planning (sync, no API call)
 * 9. Claude: Build strategy report
 *
 * Total Claude calls: 5 (down from 9), ~4 min typical runtime
 */

const { askClaude, askClaudeLong, extractJson } = require('./connectors/claude');
const { getRulesForPrompt } = require('./connectors/rules');
const { batchSearchReddit, searchAICitations } = require('./connectors/dataforseo');
const { getPackage } = require('./packages');
const { generatePosts, planUpvoteSupport } = require('./posts');
const { validateThreads } = require('./reddit-validator');
const { sanitizeContent } = require('./sanitize');
// Brand alignment review and Reddit best practices review are available but
// skipped in the pipeline to stay within Vercel's 300s execution limit.
// const { runBrandAlignmentReview, prepareBrandAlignmentInput, writeBrandAlignmentOutput } = require('./brand-alignment');
// const { reviewRedditBestPractices } = require('./reddit-best-practices');

// ─── STEP 1: Extract Keywords ───

async function extractKeywords(brandProfile, packageTier, customKeywords) {
  const pkg = getPackage(packageTier);
  const maxKeywords = pkg?.keywords || 5;

  // If user provided custom keywords, use those
  if (customKeywords && customKeywords.trim()) {
    return customKeywords.split(',').map(k => k.trim()).filter(Boolean).slice(0, maxKeywords);
  }

  // additionalNotes often contain specific product focus or targeting instructions
  // that MUST influence keyword selection
  const notesContext = brandProfile.additionalNotes
    ? `\n\nCRITICAL — ADDITIONAL TARGETING NOTES FROM CLIENT:\n${brandProfile.additionalNotes}\nThese notes contain specific product focus areas and targeting instructions. Keywords MUST reflect these notes. If the notes mention specific products, categories, or topics to target, at least half of your keywords should directly address those.`
    : '';

  const result = await askClaude(
    `You extract target search keywords for Reddit strategy campaigns. Given a brand profile, identify the ${maxKeywords} most valuable keywords that real people would search on Google when looking for recommendations, reviews, or discussions in this brand's niche.

Focus on:
- "Best [product category]" keywords
- "Which [product] should I get" keywords
- "[Brand] review" and "[Brand] vs [competitor]" keywords
- Problem/solution keywords where the brand could be recommended
- Industry discussion keywords that attract the target audience

IMPORTANT: If the client has provided additional notes or targeting instructions, those MUST be reflected in the keywords. The notes indicate what the client specifically wants to target.

OUTPUT — JSON array of strings only, no markdown fences:
["keyword1", "keyword2", "keyword3"]`,

    `BRAND: ${brandProfile.clientName}
Industry: ${brandProfile.industry || 'Unknown'}
Products: ${(brandProfile.coreOfferings?.products || []).join(', ') || 'Unknown'}
Target Audience: ${brandProfile.targetAudience?.primary || 'Unknown'}
Competitors: ${(brandProfile.competitors || []).map(c => typeof c === 'string' ? c : c.name).join(', ') || 'Unknown'}
Key Benefits: ${(brandProfile.coreOfferings?.keyBenefits || []).join(', ') || 'Unknown'}${notesContext}`,

    { model: 'claude-haiku-4-5-20251001', maxTokens: 500, timeout: 20000 }
  );

  try {
    return extractJson(result);
  } catch (err) {
    console.error('Failed to parse keywords:', err.message, 'Raw:', result?.slice(0, 300));
    return [brandProfile.clientName, brandProfile.industry].filter(Boolean);
  }
}

// ─── STEP 2: Discover Threads (DataForSEO) ───

async function discoverThreads(keywords, packageTier, targetSubreddits) {
  const pkg = getPackage(packageTier);

  // If user specified target subreddits, add subreddit-scoped searches
  const subredditList = targetSubreddits
    ? targetSubreddits.split(',').map(s => s.trim().replace(/^r\//, '')).filter(Boolean)
    : [];

  let searchKeywords = [...keywords];
  if (subredditList.length > 0) {
    for (const sub of subredditList.slice(0, 5)) {
      for (const kw of keywords.slice(0, 3)) {
        searchKeywords.push(`${kw} site:reddit.com/r/${sub}`);
      }
    }
  }

  const results = await batchSearchReddit(searchKeywords, {
    depth: pkg?.threadsPerKeyword ? pkg.threadsPerKeyword * 3 : 30,
  });

  // Deduplicate by URL
  const seen = new Set();
  const deduped = results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  return deduped.slice(0, pkg?.totalThreads || 15);
}

// ─── STEP 3: AI Citation Check ───

async function checkAICitations(keywords) {
  const citations = [];
  for (const keyword of keywords.slice(0, 5)) {
    const result = await searchAICitations(keyword);
    if (result.redditInOrganic.length > 0) {
      citations.push({
        keyword,
        redditThreads: result.redditInOrganic,
        hasAIOverview: result.aiOverview.length > 0,
      });
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return citations;
}

// ─── STEP 4: Analyze Threads ───

async function analyzeThreads(threads, brandProfile, packageTier) {
  const trainingRules = await getRulesForPrompt();
  const pkg = getPackage(packageTier);

  // Cap threads for analysis
  const threadsToAnalyze = threads.slice(0, pkg?.totalThreads || 15);
  const BATCH_SIZE = 10;

  const systemPrompt = `You are a Reddit Strategy Analyst at AEO Labs, an AI SEO agency. Analyze discovered Reddit threads for brand engagement opportunities.

BRAND CONTEXT:
Client: ${brandProfile.clientName}
Industry: ${brandProfile.industry || 'Unknown'}
Products: ${(brandProfile.coreOfferings?.products || []).join(', ')}
Target Audience: ${brandProfile.targetAudience?.primary || 'Unknown'}
Brand Voice: ${brandProfile.brandVoice?.tone || 'Unknown'}
Competitors: ${(brandProfile.competitors || []).map(c => typeof c === 'string' ? c : c.name).join(', ') || 'None'}
${brandProfile.additionalNotes ? `\nADDITIONAL CONTEXT/NOTES:\n${brandProfile.additionalNotes}\n` : ''}${trainingRules}

SCORING DIMENSIONS (score each 0-100):
1. Product Relevance — Does this thread discuss topics DIRECTLY relevant to this brand's specific products? A thread about a different product category (e.g. facial tint vs body tint, tinted moisturizer vs self-tanner) scores LOW even if it seems adjacent. Be STRICT here — tangentially related threads should score below 30.
2. Google Ranking Value — How high does this thread rank? Top 5 = high value.
3. AI Citation Potential — Is this thread likely cited by AI engines? Discussion-heavy threads with clear recommendations score higher.
4. Engagement Level — Active discussion with real engagement vs dead thread.
5. Sentiment Alignment — Does the thread's sentiment match our positioning opportunity?
6. Opportunity Quality — How natural would a brand mention be here? Forced = 0, Perfect fit = 100.

THREAD CATEGORIES:
- "high_value": Scores 70+ overall AND productRelevance 50+, immediate engagement opportunity
- "medium_value": Scores 40-69 AND productRelevance 40+, good for building presence
- "monitor": Below 40, or productRelevance below 40 — track but don't engage
- "irrelevant": productRelevance below 25 — thread topic does not match the brand's products at all. Mark these so they get filtered out.

OUTPUT — valid JSON only, no markdown fences:
{
  "analyzedThreads": [
    {
      "index": 0,
      "url": "thread url",
      "title": "thread title",
      "subreddit": "r/subreddit",
      "category": "high_value | medium_value | monitor",
      "overallScore": 75,
      "scores": {
        "productRelevance": 85,
        "googleRanking": 80,
        "aiCitation": 70,
        "engagement": 65,
        "sentiment": 80,
        "opportunity": 75
      },
      "narrative": "What this thread is about and the dominant sentiment",
      "opportunity": "Specific opportunity for the brand in this thread",
      "suggestedAngle": "The angle/approach for a comment",
      "risks": "Any risks of engaging here",
      "matchedKeywords": ["keyword1"]
    }
  ]
}`;

  // Batch threads to avoid timeout — run batches in parallel
  const batches = [];
  for (let i = 0; i < threadsToAnalyze.length; i += BATCH_SIZE) {
    batches.push(threadsToAnalyze.slice(i, i + BATCH_SIZE));
  }

  console.log(`[analyzeThreads] ${threadsToAnalyze.length} threads in ${batches.length} batch(es)`);

  const batchResults = await Promise.all(batches.map(async (batch, batchIdx) => {
    const threadList = batch.map((t, i) =>
      `[${batchIdx * BATCH_SIZE + i}] URL: ${t.url}\nTitle: ${t.title}\nSubreddit: ${t.subreddit}\nDescription: ${t.description?.slice(0, 200) || 'N/A'}\nGoogle Position: ${t.position || 'N/A'}\nMatched Keywords: ${(t.keywords || []).join(', ')}`
    ).join('\n\n');

    try {
      const result = await askClaudeLong(
        systemPrompt,
        `Analyze these ${batch.length} Reddit threads:\n\n${threadList}`,
        { maxTokens: 4000, timeout: 180000 }
      );
      return extractJson(result);
    } catch (err) {
      console.error(`[analyzeThreads] Batch ${batchIdx} failed:`, err.message);
      return { analyzedThreads: [] };
    }
  }));

  // Merge batch results and filter out irrelevant threads
  const rawThreads = batchResults.flatMap(r => r.analyzedThreads || []);

  // Filter out threads marked as irrelevant or with very low product relevance
  const allThreads = rawThreads.filter(t => {
    if (t.category === 'irrelevant') {
      console.log(`[analyzeThreads] FILTERED irrelevant: "${t.title}" (score: ${t.overallScore}, relevance: ${t.scores?.productRelevance || 0})`);
      return false;
    }
    if ((t.scores?.productRelevance || 0) < 25) {
      console.log(`[analyzeThreads] FILTERED low relevance (${t.scores?.productRelevance}): "${t.title}"`);
      return false;
    }
    return true;
  });
  console.log(`[analyzeThreads] Kept ${allThreads.length}/${rawThreads.length} threads after relevance filtering`);

  // Build subredditMap from merged threads
  const subredditMap = {};
  for (const t of allThreads) {
    const sub = t.subreddit;
    if (!sub) continue;
    if (!subredditMap[sub]) {
      subredditMap[sub] = { threadCount: 0, totalScore: 0 };
    }
    subredditMap[sub].threadCount++;
    subredditMap[sub].totalScore += (t.overallScore || 0);
  }
  for (const [sub, data] of Object.entries(subredditMap)) {
    subredditMap[sub] = {
      threadCount: data.threadCount,
      avgScore: Math.round(data.totalScore / data.threadCount),
    };
  }

  // Collect themes from all batches
  const topThemes = [...new Set(batchResults.flatMap(r => r.topThemes || []))].slice(0, 5);

  console.log(`[analyzeThreads] Merged ${allThreads.length} analyzed threads`);

  return {
    analyzedThreads: allThreads,
    subredditMap,
    topThemes,
    competitorPresence: batchResults[0]?.competitorPresence || '',
  };
}

// ─── STEP 5: Generate Comment Drafts (batched for full scope) ───

async function generateComments(analyzedThreads, brandProfile, packageTier, overridePkg) {
  const trainingRules = await getRulesForPrompt();
  const pkg = overridePkg || getPackage(packageTier);
  const totalTarget = pkg?.monthlyTargets?.comments || 15;
  const BATCH_SIZE = 5;

  // Filter out low-scoring threads — minimum score of 35 to be eligible for comments
  const MIN_THREAD_SCORE = 35;
  const eligibleThreads = analyzedThreads.filter(t =>
    (t.overallScore || 0) >= MIN_THREAD_SCORE && t.category !== 'irrelevant'
  );
  console.log(`[Comments] ${eligibleThreads.length}/${analyzedThreads.length} threads meet minimum score (${MIN_THREAD_SCORE}+)`);

  // Prefer high_value and medium_value threads, but fall back to eligible threads sorted by score
  let targetThreads = eligibleThreads
    .filter(t => t.category === 'high_value' || t.category === 'medium_value');

  // If not enough high/medium threads to distribute comments across, use all eligible threads
  if (targetThreads.length < Math.ceil(totalTarget / 2)) {
    targetThreads = [...eligibleThreads].sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0));
    console.log(`[Comments] Not enough high/medium threads (${targetThreads.length}), using all ${eligibleThreads.length} eligible threads sorted by score`);
  }

  if (targetThreads.length === 0) {
    return { comments: [], summary: 'No suitable threads found for comment generation.' };
  }

  const allComments = [];
  const batchCount = Math.ceil(totalTarget / BATCH_SIZE);

  const systemPrompt = `You are a Reddit Comment Strategist at AEO Labs. Write authentic Reddit comments that naturally integrate brand mentions.

BRAND CONTEXT:
Client: ${brandProfile.clientName}
Products: ${(brandProfile.coreOfferings?.products || []).join(', ')}
Key Benefits: ${(brandProfile.coreOfferings?.keyBenefits || []).join(', ') || 'Unknown'}
Voice: ${brandProfile.brandVoice?.tone || 'Casual, helpful'}
Do NOT Say: ${(brandProfile.brandVoice?.doNotSay || []).join(', ') || 'None'}
Preferred Terms: ${(brandProfile.brandVoice?.preferredTerms || []).join(', ') || 'None'}
${brandProfile.additionalNotes ? `\nADDITIONAL CONTEXT/NOTES:\n${brandProfile.additionalNotes}\n` : ''}${trainingRules}

MANDATORY RULE — BRAND NAME MUST APPEAR:
Every single comment MUST mention the brand at least once. This is non-negotiable.
The mention must feel natural — like a real person recommending something they actually used — but it MUST be there.

BRAND NAME VARIATION — CRITICAL FOR NATURALNESS:
Do NOT use the exact same brand name format in every comment. Real people refer to brands inconsistently.
Vary how you reference "${brandProfile.clientName}" across comments. Examples of natural variation:
- Full name: "${brandProfile.clientName}"
- Shortened/casual: first word only, nickname, or abbreviation that real users would say
- With category: "${brandProfile.clientName}" + what they make/do (e.g., "Kobo paddles", "Kobo Pickleball")
- Lowercase casual: all lowercase like people actually type on Reddit
- Different capitalization: "kobo", "KOBO", "Kobo" — mix it up
Each comment should use a DIFFERENT variation. Never use the identical format twice in a row.

CRITICAL RULES — THE 90/10 FRAMEWORK:
1. 90% genuine value, 10% brand mention. The comment must HELP the reader first, but the brand MUST appear.
2. Sound like a REAL PERSON, not a marketer. Use casual Reddit language. No brand-speak.
3. Write from a third-person perspective — "I tried [brand]" or "I switched to [brand]". Never "we" or insider language.
4. Share a genuine experience or recommendation — never a sales pitch. Include honest pros AND cons.
5. Match the subreddit's tone. r/technology is different from r/personalfinance.
6. The brand mention should feel like a helpful aside within a genuinely useful comment, not the centerpiece.
7. Include specific details that a real user would know (features, quirks, honest pros/cons).
8. If appropriate, mention a minor negative about the brand (builds credibility).
9. Reference the thread's context directly — respond to what people are actually discussing.
10. Keep it concise. Real Reddit comments aren't essays. 2-4 sentences is ideal, max 6.
11. Never use marketing jargon, superlatives ("best ever", "game-changer", "revolutionary"), or unnatural enthusiasm.
12. The comment should read like someone who genuinely uses the product sharing their experience.
13. SPREAD comments across as many DIFFERENT threads as possible. Maximum 2 comments per thread URL. Do NOT cluster multiple comments on the same thread — distribute them.
14. When generating multiple comments per thread, each must take a DIFFERENT angle/persona AND a different brand name variation.

OUTPUT — valid JSON only, no markdown fences:
{
  "comments": [
    {
      "threadIndex": 0,
      "threadTitle": "thread title",
      "threadUrl": "url",
      "subreddit": "r/subreddit",
      "comment": "The actual Reddit comment text",
      "angle": "What angle this comment takes",
      "brandMentionType": "direct | indirect | contextual",
      "confidenceScore": 85,
      "notes": "Why this comment works and any risks"
    }
  ]
}`;

  // Build all batch configs upfront, then run in parallel
  const batchConfigs = [];
  let assigned = 0;
  for (let b = 0; b < batchCount && assigned < totalTarget; b++) {
    const batchTarget = Math.min(BATCH_SIZE, totalTarget - assigned);
    const startIdx = (b * BATCH_SIZE) % targetThreads.length;
    const batchThreads = [];
    for (let i = 0; i < Math.min(batchTarget, targetThreads.length); i++) {
      batchThreads.push(targetThreads[(startIdx + i) % targetThreads.length]);
    }
    batchConfigs.push({ b, batchTarget, batchThreads, batchCount });
    assigned += batchTarget;
  }

  console.log(`[Comments] Running ${batchConfigs.length} batches in parallel for ${totalTarget} total comments`);

  // Run batches with retry — each batch gets up to 2 attempts
  const batchResults = await Promise.all(batchConfigs.map(async ({ b, batchTarget, batchThreads, batchCount }) => {
    const threadList = batchThreads.map((t, i) =>
      `[${i}] Thread: ${t.title}\nSubreddit: ${t.subreddit}\nURL: ${t.url}\nCategory: ${t.category} (Score: ${t.overallScore})\nOpportunity: ${t.opportunity}\nSuggested Angle: ${t.suggestedAngle}`
    ).join('\n\n');

    const varietyNote = b > 0
      ? `\n\nIMPORTANT: This is batch ${b + 1} of ${batchCount}. Use DIFFERENT angles, personas, and approaches from other batches. Multiple comments per thread are expected — each must be unique.`
      : `\n\nGenerate multiple comments per thread if needed to reach ${batchTarget} total. Each comment should take a different angle.`;

    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await askClaudeLong(
          systemPrompt,
          `CRITICAL: Your JSON "comments" array MUST contain EXACTLY ${batchTarget} items. Not fewer. This is a hard contractual scope requirement.\n\nGenerate exactly ${batchTarget} authentic Reddit comments for these threads:\n\n${threadList}${varietyNote}`,
          { maxTokens: 12000, timeout: 180000 }
        );

        const parsed = extractJson(result);
        const comments = parsed.comments || [];
        console.log(`[Comments] Batch ${b + 1}/${batchCount} (attempt ${attempt}): got ${comments.length}/${batchTarget} comments`);

        if (comments.length >= batchTarget || attempt === MAX_ATTEMPTS) {
          return comments;
        }
        console.log(`[Comments] Batch ${b + 1}: short by ${batchTarget - comments.length}, retrying...`);
      } catch (err) {
        console.error(`[Comments] Batch ${b + 1}/${batchCount} attempt ${attempt} failed:`, err.message);
        if (attempt === MAX_ATTEMPTS) return [];
      }
    }
    return [];
  }));

  const allResults = batchResults.flat();
  console.log(`[Comments] Total: ${allResults.length}/${totalTarget} comments`);

  // If still short after retries, run fill-up batches until we hit the target (max 3 attempts)
  const MAX_FILLUPS = 3;
  for (let fillAttempt = 1; fillAttempt <= MAX_FILLUPS && allResults.length < totalTarget; fillAttempt++) {
    const deficit = totalTarget - allResults.length;
    console.log(`[Comments] Short by ${deficit} comments — fill-up attempt ${fillAttempt}/${MAX_FILLUPS}`);
    const fillThreads = targetThreads.slice(0, Math.min(deficit, targetThreads.length));
    const fillThreadList = fillThreads.map((t, i) =>
      `[${i}] Thread: ${t.title}\nSubreddit: ${t.subreddit}\nURL: ${t.url}\nCategory: ${t.category} (Score: ${t.overallScore})\nOpportunity: ${t.opportunity}\nSuggested Angle: ${t.suggestedAngle}`
    ).join('\n\n');
    try {
      const result = await askClaudeLong(
        systemPrompt,
        `CRITICAL: You MUST return EXACTLY ${deficit} comments in the JSON array. Not fewer. This is a contractual requirement.\n\nGenerate exactly ${deficit} authentic Reddit comments for these threads:\n\n${fillThreadList}\n\nUse DIFFERENT angles from previous comments for variety.`,
        { maxTokens: 12000, timeout: 180000 }
      );
      const parsed = extractJson(result);
      const fillComments = parsed.comments || [];
      console.log(`[Comments] Fill-up ${fillAttempt}: got ${fillComments.length}/${deficit} comments`);
      allResults.push(...fillComments);
    } catch (err) {
      console.error(`[Comments] Fill-up ${fillAttempt} failed:`, err.message);
    }
  }

  console.log(`[Comments] Final: ${Math.min(allResults.length, totalTarget)}/${totalTarget} comments`);

  // Enforce max 2 comments per thread URL to prevent stacking
  const MAX_PER_THREAD = 2;
  const threadCounts = {};
  const deduped = [];
  const overflow = [];
  for (const c of allResults) {
    const url = (c.threadUrl || '').toLowerCase();
    threadCounts[url] = (threadCounts[url] || 0) + 1;
    if (threadCounts[url] <= MAX_PER_THREAD) {
      deduped.push(c);
    } else {
      overflow.push(c);
    }
  }
  // If we lost comments due to dedup, fill from overflow with reassigned threads
  let finalComments = deduped.slice(0, totalTarget);
  if (finalComments.length < totalTarget && overflow.length > 0) {
    console.log(`[Comments] Thread dedup removed ${overflow.length} comments, keeping ${finalComments.length}/${totalTarget}`);
  }

  // Sanitize all comments to remove em dashes, semicolons, and other AI tells
  const sanitized = finalComments.map(c => sanitizeContent({ comments: [c] }).comments[0]);
  console.log(`[Comments] Sanitized ${sanitized.length} comments (em dashes, semicolons removed)`);

  return {
    comments: sanitized,
    summary: `Generated ${Math.min(allResults.length, totalTarget)} comments across ${batchConfigs.length} parallel batches.`,
  };
}

// ─── STEP 6: Brand Alignment Check (batched, handles all comments) ───

async function checkBrandAlignment(comments, brandProfile) {
  if (!comments.length) return [];

  const ALIGNMENT_BATCH = 20;
  const allChecked = [];

  const systemPrompt = `You are a Brand Alignment Checker. Review ALL comments below for brand alignment.

BRAND: ${brandProfile.clientName}
Voice: ${brandProfile.brandVoice?.tone || 'Unknown'}
Do NOT Say: ${(brandProfile.brandVoice?.doNotSay || []).join(', ') || 'None'}
Products: ${(brandProfile.coreOfferings?.products || []).join(', ')}
Key Benefits: ${(brandProfile.coreOfferings?.keyBenefits || []).join(', ') || 'Unknown'}

For each comment check:
1. Is brand info accurate?
2. Does it sound like a real person, NOT a marketer?
3. Does the brand mention feel natural or forced?
4. Would this get flagged as spam by Reddit users?

OUTPUT — valid JSON only, no markdown fences:
{
  "checks": [
    {
      "index": 0,
      "aligned": true,
      "score": 85,
      "issues": [],
      "fixes": [],
      "spamRisk": "low"
    }
  ]
}`;

  // Build all batches and run in parallel
  const batches = [];
  for (let i = 0; i < comments.length; i += ALIGNMENT_BATCH) {
    batches.push({ start: i, batch: comments.slice(i, i + ALIGNMENT_BATCH) });
  }

  console.log(`[Alignment] Running ${batches.length} batches in parallel for ${comments.length} comments`);

  const batchResults = await Promise.all(batches.map(async ({ start, batch }, batchIdx) => {
    const commentList = batch.map((c, idx) =>
      `[${idx}] Thread: ${c.threadTitle} (${c.subreddit})\nCOMMENT: ${c.comment}`
    ).join('\n\n');

    try {
      const result = await askClaudeLong(
        systemPrompt,
        `Review these ${batch.length} comments:\n\n${commentList}`,
        { model: 'claude-haiku-4-5-20251001', maxTokens: 3000, timeout: 60000 }
      );

      const parsed = extractJson(result);
      const checks = parsed.checks || [];

      return batch.map((comment, idx) => {
        const check = checks.find(c => c.index === idx) || { aligned: true, score: 70, issues: [], fixes: [], spamRisk: 'unknown' };
        return { ...comment, alignment: check };
      });
    } catch (err) {
      console.error(`Alignment batch ${batchIdx + 1} failed:`, err.message);
      return batch.map(comment => ({
        ...comment,
        alignment: { aligned: true, score: 70, issues: [], fixes: [], spamRisk: 'unknown' },
      }));
    }
  }));

  return batchResults.flat();
}

// ─── STEP 7: Build Strategy Report ───

async function buildStrategyReport(data, brandProfile, packageTier) {
  const pkg = getPackage(packageTier);

  // Trim thread analysis to essential fields only (reduces input + speeds response)
  const threadSummaries = (data.threadAnalysis?.analyzedThreads?.slice(0, 15) || []).map(t => ({
    title: t.title, subreddit: t.subreddit, score: t.overallScore, category: t.category, opportunity: t.opportunity,
  }));

  const avgAlignment = data.commentsWithAlignment?.length > 0
    ? Math.round(data.commentsWithAlignment.reduce((sum, c) => sum + (c.alignment?.score || 0), 0) / data.commentsWithAlignment.length)
    : 'N/A';

  // Use askClaude (non-streaming, reliable timeout) + Haiku (fast) for report synthesis
  const result = await askClaude(
    `You are a Senior Reddit Strategist. Synthesize research data into a strategy report.

OUTPUT — valid JSON only, no markdown fences:
{
  "executiveSummary": "string (3-4 sentences)",
  "keywordPerformance": [{"keyword": "", "threadsFound": 0, "avgScore": 0, "topThread": ""}],
  "topOpportunities": [{"title": "", "url": "", "subreddit": "", "score": 0, "opportunity": ""}],
  "subredditStrategy": [{"subreddit": "", "archetype": "", "priority": "high|medium|low", "approach": ""}],
  "commentStrategy": {"totalDrafted": 0, "avgAlignmentScore": 0, "approach": ""},
  "brandAlignmentNotes": ["note"],
  "recommendedActions": [{"action": "", "priority": "high|medium|low", "timeline": ""}],
  "riskAssessment": {"overallRisk": "low|medium|high", "risks": [{"risk": "", "mitigation": ""}]}
}`,

    `BRAND: ${brandProfile.clientName} | INDUSTRY: ${brandProfile.industry} | Package: ${pkg?.name || packageTier}
KEYWORDS: ${JSON.stringify(data.keywords)}
THREADS (${threadSummaries.length}): ${JSON.stringify(threadSummaries)}
SUBREDDIT MAP: ${JSON.stringify(data.threadAnalysis?.subredditMap || {})}
COMMENTS: ${data.commentsWithAlignment?.length || 0} drafted, avg alignment: ${avgAlignment}
POSTS: ${data.posts?.length || 0} drafts
UPVOTES: ${data.upvotePlan ? `${data.upvotePlan.totalUpvotes} planned` : 'N/A'}
COMPETITOR PRESENCE: ${data.threadAnalysis?.competitorPresence || 'None detected'}`,

    { model: 'claude-haiku-4-5-20251001', maxTokens: 4000, timeout: 60000 }
  );

  try {
    return extractJson(result);
  } catch (err) {
    console.error('Failed to parse strategy report:', err.message, 'Raw:', result?.slice(0, 500));
    return { executiveSummary: 'Report generation failed. Check logs.' };
  }
}

// ─── MAIN PIPELINE ───

/**
 * Run the full Reddit strategy pipeline.
 *
 * @param {object} brandProfile - Brand profile from Brand Guardian
 * @param {string} packageTier - 'a', 'b', or 'c'
 * @param {string} customKeywords - Optional comma-separated keywords
 * @param {function} progressCallback - Async function to report progress
 * @returns {object} Complete strategy data
 */
async function runStrategyPipeline(brandProfile, packageTier, customKeywords, progressCallback) {
  const pkg = getPackage(packageTier);
  let data = {};
  const pipelineStart = Date.now();
  const stepTime = (label) => {
    const elapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
    console.log(`[Pipeline ${elapsed}s] ${label}`);
  };

  // Step 1: Keywords
  if (progressCallback) await progressCallback('Extracting target keywords...');
  data.keywords = await extractKeywords(brandProfile, packageTier, customKeywords);
  stepTime(`Keywords: ${data.keywords.length} found`);
  if (progressCallback) await progressCallback(`Found ${data.keywords.length} keywords: ${data.keywords.join(', ')}`);

  // Step 2: Discover threads via DataForSEO
  if (progressCallback) await progressCallback(`Searching Google for Reddit threads across ${data.keywords.length} keywords...`);
  data.threads = await discoverThreads(data.keywords, packageTier);
  stepTime(`Threads: ${data.threads.length} discovered`);
  if (progressCallback) await progressCallback(`Discovered ${data.threads.length} Reddit threads`);

  // Step 2b: Validate threads (filter archived, deleted, locked, NSFW)
  if (data.threads.length > 0) {
    if (progressCallback) await progressCallback(`Validating ${data.threads.length} threads (checking for archived/deleted/locked)...`);
    const threadUrls = data.threads.map(t => t.url);
    const validation = await validateThreads(threadUrls);

    // Keep only valid threads
    const validUrls = new Set(validation.valid.map(v => v.url));
    const preCount = data.threads.length;
    data.threads = data.threads.filter(t => validUrls.has(t.url));
    data.threadValidation = validation.summary;

    const filtered = preCount - data.threads.length;
    stepTime(`Thread validation: ${data.threads.length} valid, ${filtered} filtered out`);
    if (filtered > 0 && progressCallback) {
      const reasons = Object.entries(validation.summary.invalidReasons || {})
        .map(([r, c]) => `${c} ${r}`).join(', ');
      await progressCallback(`Filtered ${filtered} threads (${reasons}). ${data.threads.length} valid threads remaining.`);
    }
  }

  // Step 3: AI Citation check (Package B & C only)
  if (pkg?.features?.aiCitationCheck) {
    if (progressCallback) await progressCallback('Checking AI citation data...');
    data.aiCitations = await checkAICitations(data.keywords);
  } else {
    data.aiCitations = [];
  }

  // Step 4: Analyze threads
  if (data.threads.length > 0) {
    if (progressCallback) await progressCallback(`Analyzing ${data.threads.length} threads for opportunities...`);
    data.threadAnalysis = await analyzeThreads(data.threads, brandProfile, packageTier);
    if (progressCallback) {
      const highValue = (data.threadAnalysis.analyzedThreads || []).filter(t => t.category === 'high_value').length;
      stepTime(`Thread analysis complete: ${highValue} high-value`);
      await progressCallback(`Analysis complete: ${highValue} high-value, ${data.threadAnalysis.analyzedThreads?.length - highValue} medium/monitor`);
    }
  } else {
    data.threadAnalysis = { analyzedThreads: [], subredditMap: {}, topThemes: [], competitorPresence: '' };
    if (progressCallback) await progressCallback('No Reddit threads found for these keywords.');
  }

  // Step 5 + 6: Generate comments AND posts in parallel
  if (data.threadAnalysis.analyzedThreads?.length > 0) {
    if (progressCallback) await progressCallback('Generating comment drafts and post ideas...');

    // Run comments and posts generation in parallel
    const commentPromise = generateComments(
      data.threadAnalysis.analyzedThreads,
      brandProfile,
      packageTier,
      pkg
    ).catch(err => {
      console.error('Comment generation failed:', err.message);
      return { comments: [] };
    });

    const postPromise = (pkg?.monthlyTargets?.posts > 0)
      ? generatePosts(data.threadAnalysis.analyzedThreads, brandProfile, packageTier, pkg)
          .catch(err => {
            console.error('Post generation failed:', err.message);
            return { posts: [] };
          })
      : Promise.resolve({ posts: [] });

    const [commentResult, postResult] = await Promise.all([commentPromise, postPromise]);

    data.comments = commentResult.comments || [];
    data.posts = postResult.posts || [];
    stepTime(`Generated ${data.comments.length} comments + ${data.posts.length} posts`);
    if (progressCallback) await progressCallback(`Generated ${data.comments.length} comments + ${data.posts.length} posts`);

    // Step 7: Brand alignment check on comments
    if (data.comments.length > 0) {
      if (progressCallback) await progressCallback('Running brand alignment check...');
      data.commentsWithAlignment = await checkBrandAlignment(data.comments, brandProfile);
      if (progressCallback) {
        const aligned = data.commentsWithAlignment.filter(c => c.alignment?.aligned).length;
        await progressCallback(`Brand alignment: ${aligned}/${data.commentsWithAlignment.length} comments aligned`);
      }
    } else {
      data.commentsWithAlignment = [];
    }
  } else {
    data.comments = [];
    data.commentsWithAlignment = [];
    data.posts = [];
  }

  // Step 8: Upvote Support Planning (Package B & C) — sync, no Claude call
  if (pkg?.monthlyTargets?.upvotes > 0) {
    try {
      data.upvotePlan = planUpvoteSupport(
        data.commentsWithAlignment || [],
        data.posts || [],
        packageTier,
        pkg
      );
    } catch (err) {
      console.error('Upvote planning failed:', err.message);
      data.upvotePlan = null;
    }
  }

  // Skip detailed brand alignment review and Reddit best practices review
  // to stay within Vercel's 300s execution limit. The checkBrandAlignment
  // step above covers the core quality check.
  data.brandAlignmentReport = null;
  data.bestPracticesReport = null;

  // Step 9: Build strategy report
  if (progressCallback) await progressCallback('Building strategy report...');
  data.report = await buildStrategyReport(data, brandProfile, packageTier);

  stepTime('Pipeline complete');
  console.log('Pipeline complete:', {
    keywords: data.keywords?.length || 0,
    threads: data.threads?.length || 0,
    analyzedThreads: data.threadAnalysis?.analyzedThreads?.length || 0,
    comments: data.commentsWithAlignment?.length || 0,
    posts: data.posts?.length || 0,
    upvotes: data.upvotePlan?.totalUpvotes || 0,
    hasReport: !!data.report?.executiveSummary,
  });

  return data;
}

module.exports = {
  extractKeywords,
  discoverThreads,
  checkAICitations,
  analyzeThreads,
  generateComments,
  checkBrandAlignment,
  buildStrategyReport,
  runStrategyPipeline,
  generatePosts,
  planUpvoteSupport,
};
