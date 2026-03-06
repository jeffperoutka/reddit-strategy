/**
 * Reddit Strategy Packages
 *
 * Defines the scope and deliverables for each package tier.
 * Package selection controls: keyword count, thread count, comment count,
 * subreddit depth, and whether advanced features are included.
 */

const PACKAGES = {
  a: {
    name: 'Package A — Foundation',
    description: 'Entry-level Reddit presence. Brand monitoring + seed engagement.',
    keywords: 3,           // Number of target keywords to research
    threadsPerKeyword: 5,  // Max threads to analyze per keyword
    totalThreads: 10,      // Max total threads in final strategy
    commentsToGenerate: 5, // Number of comment drafts to generate
    features: {
      serpAnalysis: true,        // Google SERP + Reddit discovery
      aiCitationCheck: false,    // AI engine citation tracking
      threadAnalysis: true,      // Deep thread analysis
      commentDrafting: true,     // Generate brand-aligned comments
      brandAlignment: true,      // Check with Brand Guardian
      subredditMapping: false,   // Community archetype mapping
      karmaLadder: false,        // Multi-phase engagement plan
      competitorAnalysis: false, // Track competitor Reddit presence
    },
    monthlyTargets: {
      comments: 10,
      threads: 0,       // No new threads at this tier
      upvoteSupport: false,
    },
  },

  b: {
    name: 'Package B — Authority',
    description: 'Active Reddit engagement. Thread targeting + comment strategy + QA workflow.',
    keywords: 6,
    threadsPerKeyword: 10,
    totalThreads: 20,
    commentsToGenerate: 12,
    features: {
      serpAnalysis: true,
      aiCitationCheck: true,
      threadAnalysis: true,
      commentDrafting: true,
      brandAlignment: true,
      subredditMapping: true,
      karmaLadder: true,
      competitorAnalysis: false,
    },
    monthlyTargets: {
      comments: 25,
      threads: 3,
      upvoteSupport: true,
    },
  },

  c: {
    name: 'Package C — Domination',
    description: 'Full Reddit authority. Multi-subreddit strategy + new threads + competitor displacement.',
    keywords: 10,
    threadsPerKeyword: 15,
    totalThreads: 30,
    commentsToGenerate: 20,
    features: {
      serpAnalysis: true,
      aiCitationCheck: true,
      threadAnalysis: true,
      commentDrafting: true,
      brandAlignment: true,
      subredditMapping: true,
      karmaLadder: true,
      competitorAnalysis: true,
    },
    monthlyTargets: {
      comments: 50,
      threads: 8,
      upvoteSupport: true,
    },
  },
};

function getPackage(tier) {
  const key = tier?.toLowerCase?.()?.trim?.();
  return PACKAGES[key] || null;
}

function getPackageOptions() {
  return Object.entries(PACKAGES).map(([key, pkg]) => ({
    key,
    name: pkg.name,
    description: pkg.description,
  }));
}

module.exports = { PACKAGES, getPackage, getPackageOptions };
