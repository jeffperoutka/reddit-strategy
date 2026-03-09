/**
 * Reddit Strategy Packages
 *
 * Defines the scope and deliverables for each package tier.
 * Package selection controls: keyword count, thread count, comment/post count,
 * subreddit depth, upvote allocation, and feature access.
 */

const PACKAGES = {
  a: {
    name: 'Package A',
    description: 'Core Reddit presence. Posts, comments, and upvote support.',
    keywords: 6,
    threadsPerKeyword: 10,
    totalThreads: 20,
    commentsToGenerate: 15,
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
      posts: 15,
      comments: 50,
      upvotes: 150,
    },
  },

  b: {
    name: 'Package B',
    description: 'Expanded Reddit authority. Higher volume across posts, comments, and upvotes.',
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
      posts: 30,
      comments: 65,
      upvotes: 150,
    },
  },

  custom: {
    name: 'Custom Scope',
    description: 'Custom engagement scope. Posts, comments, and upvotes defined per client.',
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
      posts: 0,    // Set per client
      comments: 0, // Set per client
      upvotes: 0,  // Set per client
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
