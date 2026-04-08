/**
 * Run: node test/testTrustScore.js (from sci-khcn-publications directory)
 */
import { computeTrustScore, resolveResearcherKey } from '../src/lib/trustScoring.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Case 1: SCI stem cell paper — expect score > 80 (Keep)
const t1 = computeTrustScore(
  {
    title: 'Mesenchymal stem cell therapy for liver injury',
    year: 2018,
    authors: ['John Smith', 'Phan Kim Ngoc'],
    affiliations: ['University of Science, VNU-HCM'],
    issn: '1422-0067',
  },
  'pham_van_phuc'
);
console.log('T1', t1.trust_score, t1.classification);
assert(t1.trust_score > 80, 'T1: expect score > 80 (High Confidence)');
assert(t1.classification === 'High Confidence - Keep', 'T1: classification');

// Case 2: Similar topic but Hanoi / negative affiliation — expect Exclude
const t2 = computeTrustScore(
  {
    title: 'Mesenchymal stem cells in regenerative medicine',
    year: 2019,
    authors: [],
    affiliations: ['Hanoi University'],
    crawledBodyText: 'research at hanoi university department',
  },
  'pham_van_phuc'
);
console.log('T2', t2.trust_score, t2.classification);
assert(t2.trust_score < 0, 'T2: expect Exclude (score < 0)');

// Case 3: Unrelated field, no affiliation — expect Exclude (year < 2005 adds -20)
const t3 = computeTrustScore(
  {
    title: 'Macroeconomic forecasting models',
    year: 2003,
    authors: [],
    affiliations: [],
  },
  'pham_van_phuc'
);
console.log('T3', t3.trust_score, t3.classification);
assert(t3.trust_score < 0, 'T3: expect Exclude');

// Case 4: SCI coauthor in list, no affiliation in metadata — expect Manual Review
const t4 = computeTrustScore(
  {
    title: 'Some generic publication title',
    year: 2010,
    authors: ['Le Van Dong', 'Jane Doe'],
    affiliations: [],
  },
  'pham_van_phuc'
);
console.log('T4', t4.trust_score, t4.classification);
assert(t4.trust_score >= 0 && t4.trust_score <= 80, 'T4: expect Manual Review band');
assert(t4.classification === 'Manual Review Needed', 'T4: classification');

assert(resolveResearcherKey('pham_van_phuc') === 'pham_van_phuc', 'resolve: key');
assert(resolveResearcherKey('Phạm Văn Phúc') === 'pham_van_phuc', 'resolve: display_name');
assert(resolveResearcherKey('Pham Van Phuc') === 'pham_van_phuc', 'resolve: variant');
assert(resolveResearcherKey('  ') === null, 'resolve: blank');
assert(resolveResearcherKey('Không tồn tại') === null, 'resolve: unknown');

// Case 5: Crawl failed — no keyword penalty when title has no domain keywords
const t5 = computeTrustScore(
  {
    title: 'Plant secondary metabolites structural analysis',
    year: 2021,
    authors: 'Mai Nguyen, Phuc Van Pham',
    affiliations: [],
    crawl_failed: true,
  },
  'pham_van_phuc'
);
console.log('T5', t5.trust_score, t5.classification, t5.flags);
assert(t5.flags.crawl_failed_no_keyword_penalty === true, 'T5: skip penalty on crawl fail');
assert(t5.trust_score >= 0, 'T5: not Exclude');

// Case 6: BibTeX-style author string + target NCV
const t6 = computeTrustScore(
  {
    title: 'Some unrelated economics title',
    year: 2020,
    authors: 'Ngoc Bich Vu and Phuc Van Pham',
    affiliations: [],
  },
  'pham_van_phuc'
);
assert(t6.flags.target_researcher_in_authors === true, 'T6: name hit');
assert(t6.trust_score > 80, 'T6: Keep via target author + coauthor + year');

// Case 7: "Last, First" order (Scholar/BibTeX) — must match target NCV by token signature
const t7 = computeTrustScore(
  {
    title: 'An evolution of stem cell research and therapy in Viet Nam',
    year: 2018,
    authors:
      'Pham, Phuc Van and Vu, Ngoc Bich and Phan, Ngoc Kim',
    affiliations: [],
    crawl_failed: true,
  },
  'pham_van_phuc'
);
console.log('T7', t7.trust_score, t7.flags.target_researcher_in_authors);
assert(t7.flags.target_researcher_in_authors === true, 'T7: Last, First still matches');
assert(t7.trust_score > 80, 'T7: stem cell title + target + coauthors → Keep');

console.log('testTrustScore: all assertions passed.');
