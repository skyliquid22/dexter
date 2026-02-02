type SourceType = 'SEC_FILING' | 'EARNINGS_RELEASE' | 'PRESS_RELEASE' | 'NEWS';

export interface NarrativeDoc {
  source_type: SourceType;
  title: string;
  body: string;
  published_at: string;
  form_type?: string;
  filing_item?: string;
  url?: string;
  id?: string;
}

export interface NarrativeShockParams {
  window_days: number;
  recency_half_life_days: number;
  source_weights: Record<SourceType, number>;
  max_points_per_event_class?: number;
  require_confirmation_for_accounting: boolean;
  structural_threshold: number;
  primary_min_threshold: number;
  macro_threshold: number;
}

export interface NarrativeShockResult {
  ticker?: string;
  window_start: string;
  window_end: string;
  primary_event_class: string;
  shock_type: 'ONE_OFF' | 'MACRO_ROTATION' | 'STRUCTURAL_RISK' | 'NONE';
  severity_0_100: number;
  structural_risk_0_100: number;
  mds_narrative_shock_points: 0 | 10 | 15;
  top_matches: Array<{
    event_class: string;
    pattern: string;
    source_type: SourceType;
    published_at: string;
    weight: number;
  }>;
  secondary_event_classes: Array<{
    event_class: string;
    score: number;
  }>;
}

type Pattern =
  | string
  | { all: string[]; any?: string[]; label: string };

interface EventClass {
  id: string;
  priority: number;
  strong: Pattern[];
  weak: Pattern[];
  severity: { strong: number; weak: number };
  structural: { strong: number; weak: number };
  cap: number;
}

interface ProcessedDoc {
  source_type: SourceType;
  published_at: string;
  text: string;
  weight: number;
}

interface DocMatch {
  doc: ProcessedDoc;
  strongMatches: string[];
  weakMatches: string[];
}

const DEFAULT_PARAMS: NarrativeShockParams = {
  window_days: 30,
  recency_half_life_days: 10,
  source_weights: {
    SEC_FILING: 1.0,
    EARNINGS_RELEASE: 0.9,
    PRESS_RELEASE: 0.7,
    NEWS: 0.5,
  },
  max_points_per_event_class: undefined,
  require_confirmation_for_accounting: true,
  structural_threshold: 50,
  primary_min_threshold: 10,
  macro_threshold: 10,
};

const EVENT_CLASSES: EventClass[] = [
  {
    id: 'ACCOUNTING_RESTATEMENT',
    priority: 1,
    strong: [
      'restate',
      'restatement',
      'previously issued financial statements should no longer be relied upon',
      'non-reliance',
      'revision of previously issued',
      'error in previously issued',
    ],
    weak: ['accounting error', 'misstatement', 'reclassification'],
    severity: { strong: 35, weak: 10 },
    structural: { strong: 35, weak: 10 },
    cap: 60,
  },
  {
    id: 'FRAUD_OR_INTERNAL_CONTROL',
    priority: 2,
    strong: [
      'material weakness',
      'internal control over financial reporting',
      'icfr',
      'auditor resignation',
      'resigned as our independent registered public accounting firm',
      'sec investigation',
      'doj investigation',
    ],
    weak: ['investigation', 'whistleblower', 'irregularities'],
    severity: { strong: 30, weak: 8 },
    structural: { strong: 30, weak: 8 },
    cap: 55,
  },
  {
    id: 'REGULATORY_OR_GOVERNMENT_ACTION',
    priority: 3,
    strong: [
      'consent decree',
      'cease and desist',
      'license suspended',
      'license revoked',
      'regulatory settlement',
      'ban',
      'prohibited',
      'fined',
    ],
    weak: ['inquiry', 'notice of violation', 'regulator'],
    severity: { strong: 25, weak: 6 },
    structural: { strong: 20, weak: 4 },
    cap: 45,
  },
  {
    id: 'LEGAL_LITIGATION',
    priority: 4,
    strong: [
      'class action',
      'lawsuit',
      'litigation',
      'settlement',
      'damages',
      'injunction',
    ],
    weak: ['legal proceeding', 'complaint'],
    severity: { strong: 18, weak: 5 },
    structural: { strong: 10, weak: 2 },
    cap: 35,
  },
  {
    id: 'EXECUTIVE_CHANGE',
    priority: 5,
    strong: [
      'ceo resign',
      'cfo resign',
      'chief executive officer resigned',
      'terminated',
      'effective immediately',
      'transition agreement',
    ],
    weak: ['appointed as', 'interim ceo'],
    severity: { strong: 15, weak: 4 },
    structural: { strong: 10, weak: 2 },
    cap: 25,
  },
  {
    id: 'GUIDANCE_SHOCK_OR_EARNINGS_MISS',
    priority: 6,
    strong: [
      'withdraw guidance',
      'suspending guidance',
      'lowered guidance',
      'reduced outlook',
      'missed expectations',
      'below expectations',
      'materially below',
    ],
    weak: ['headwinds', 'soft demand', 'pricing pressure', 'margin pressure'],
    severity: { strong: 18, weak: 4 },
    structural: { strong: 10, weak: 2 },
    cap: 35,
  },
  {
    id: 'PRODUCT_RECALL_OR_SAFETY',
    priority: 7,
    strong: ['recall', 'safety issue', 'product defect', 'injury', 'fatality'],
    weak: ['quality issue'],
    severity: { strong: 20, weak: 5 },
    structural: { strong: 15, weak: 3 },
    cap: 35,
  },
  {
    id: 'CYBERSECURITY_INCIDENT',
    priority: 8,
    strong: [
      'data breach',
      'ransomware',
      'cyberattack',
      'security incident',
      'unauthorized access',
    ],
    weak: ['incident response', 'forensic'],
    severity: { strong: 18, weak: 4 },
    structural: { strong: 8, weak: 2 },
    cap: 30,
  },
  {
    id: 'CREDIT_LIQUIDITY_DISTRESS',
    priority: 9,
    strong: [
      'going concern',
      'covenant breach',
      'default',
      'liquidity shortfall',
      'refinancing',
      'debt restructuring',
      'chapter 11',
    ],
    weak: ['significant doubt', 'liquidity', 'cash burn'],
    severity: { strong: 30, weak: 8 },
    structural: { strong: 30, weak: 8 },
    cap: 55,
  },
  {
    id: 'MAJOR_CONTRACT_OR_CUSTOMER_LOSS',
    priority: 10,
    strong: [
      'terminated agreement',
      'customer churn',
      'lost a major customer',
      'non-renewal',
      'largest customer',
      'material customer',
    ],
    weak: ['contract renewal', 'pipeline weakness'],
    severity: { strong: 20, weak: 5 },
    structural: { strong: 20, weak: 5 },
    cap: 40,
  },
  {
    id: 'M_AND_A_OR_STRATEGIC_REVIEW',
    priority: 11,
    strong: [
      'strategic alternatives',
      'strategic review',
      'exploring a sale',
      'acquisition',
      'merger',
    ],
    weak: ['evaluate options'],
    severity: { strong: 10, weak: 3 },
    structural: { strong: 0, weak: 0 },
    cap: 20,
  },
  {
    id: 'CAPITAL_STRUCTURE_ACTION',
    priority: 12,
    strong: [
      'dividend cut',
      'suspend dividend',
      'buyback suspended',
      'dilution',
      'secondary offering',
      'at-the-market offering',
      'atm offering',
    ],
    weak: ['issue shares', 'repurchase'],
    severity: { strong: 12, weak: 3 },
    structural: { strong: 8, weak: 2 },
    cap: 25,
  },
  {
    id: 'MACRO_ROTATION',
    priority: 13,
    strong: [
      'higher for longer',
      'interest rates',
      'inflation',
      'recession',
      'soft landing',
      'hard landing',
      'commodity cycle',
      'oil price',
      'china slowdown',
    ],
    weak: ['macro', 'sector rotation'],
    severity: { strong: 8, weak: 2 },
    structural: { strong: 0, weak: 0 },
    cap: 15,
  },
  {
    id: 'STRUCTURAL_MODEL_RISK',
    priority: 14,
    strong: [
      'structural decline',
      'secular decline',
      'demand destruction',
      'unit economics',
      {
        all: ['customer acquisition cost'],
        any: ['rising', 'spiking'],
        label: 'customer acquisition cost + rising/spiking',
      },
      {
        all: ['pricing power'],
        any: ['lost', 'deteriorating'],
        label: 'pricing power + lost/deteriorating',
      },
      {
        all: ['permanent'],
        any: ['impairment', 'headwind'],
        label: 'permanent + impairment/headwind',
      },
    ],
    weak: ['competitive pressure', 'market share loss', 'disruption'],
    severity: { strong: 0, weak: 0 },
    structural: { strong: 35, weak: 10 },
    cap: 60,
  },
];

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9%$.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchPattern(text: string, pattern: Pattern): boolean {
  if (typeof pattern === 'string') {
    return text.includes(pattern);
  }
  const hasAll = pattern.all.every((p) => text.includes(p));
  const hasAny = pattern.any ? pattern.any.some((p) => text.includes(p)) : true;
  return hasAll && hasAny;
}

function patternLabel(pattern: Pattern): string {
  if (typeof pattern === 'string') {
    return pattern;
  }
  return pattern.label;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (1000 * 60 * 60 * 24);
}

function getDocWeight(doc: NarrativeDoc, params: NarrativeShockParams, windowEnd: Date): number {
  const sourceWeight = params.source_weights[doc.source_type] ?? 0.5;
  const publishedAt = new Date(doc.published_at);
  const ageDays = daysBetween(windowEnd, publishedAt);
  const decay = Math.exp(-Math.log(2) * ageDays / params.recency_half_life_days);
  return sourceWeight * decay;
}

function buildProcessedDocs(
  docs: NarrativeDoc[],
  params: NarrativeShockParams,
  windowStart: Date,
  windowEnd: Date
): ProcessedDoc[] {
  return docs
    .filter((doc) => {
      const publishedAt = new Date(doc.published_at);
      return publishedAt >= windowStart && publishedAt <= windowEnd;
    })
    .map((doc) => {
      const docText = `${doc.title}\n${doc.body}`;
      return {
        source_type: doc.source_type,
        published_at: doc.published_at,
        text: normalizeText(docText),
        weight: getDocWeight(doc, params, windowEnd),
      };
    });
}

function computeClassScore(
  matches: DocMatch[],
  pts: { strong: number; weak: number },
  cap: number,
  downgradeStrong: boolean
): number {
  let raw = 0;
  for (const match of matches) {
    if (match.strongMatches.length > 0) {
      raw += match.doc.weight * (downgradeStrong ? pts.weak : pts.strong);
    }
    if (match.weakMatches.length > 0) {
      raw += match.doc.weight * match.weakMatches.length * pts.weak;
    }
  }
  return Math.min(raw, cap);
}

function hasAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => text.includes(p));
}

export function classifyNarrativeShock(
  docs: NarrativeDoc[],
  options: Partial<NarrativeShockParams> & { ticker?: string; window_end?: string } = {}
): NarrativeShockResult {
  const params: NarrativeShockParams = { ...DEFAULT_PARAMS, ...options };
  const windowEnd = options.window_end ? new Date(options.window_end) : new Date();
  const windowStart = new Date(windowEnd.getTime() - params.window_days * 24 * 60 * 60 * 1000);

  const processedDocs = buildProcessedDocs(docs, params, windowStart, windowEnd);

  const classMatches: Record<string, DocMatch[]> = {};
  const allMatches: NarrativeShockResult['top_matches'] = [];

  for (const eventClass of EVENT_CLASSES) {
    classMatches[eventClass.id] = [];
  }

  for (const doc of processedDocs) {
    for (const eventClass of EVENT_CLASSES) {
      const strongMatches = eventClass.strong
        .filter((p) => matchPattern(doc.text, p))
        .map((p) => patternLabel(p));
      const weakMatches = eventClass.weak
        .filter((p) => matchPattern(doc.text, p))
        .map((p) => patternLabel(p));

      if (strongMatches.length === 0 && weakMatches.length === 0) continue;

      classMatches[eventClass.id].push({
        doc,
        strongMatches,
        weakMatches,
      });

      for (const pattern of strongMatches) {
        allMatches.push({
          event_class: eventClass.id,
          pattern,
          source_type: doc.source_type,
          published_at: doc.published_at,
          weight: doc.weight,
        });
      }

      for (const pattern of weakMatches) {
        allMatches.push({
          event_class: eventClass.id,
          pattern,
          source_type: doc.source_type,
          published_at: doc.published_at,
          weight: doc.weight,
        });
      }
    }
  }

  const classScores: Record<string, number> = {};
  const structuralScores: Record<string, number> = {};

  const accountingConfirmed = (classId: string): boolean => {
    const matches = classMatches[classId];
    if (!matches || matches.length === 0) return false;
    const strongDocs = matches.filter((m) => m.strongMatches.length > 0);
    if (strongDocs.length === 0) return false;
    const hasSecFiling = strongDocs.some((m) => m.doc.source_type === 'SEC_FILING');
    if (hasSecFiling) return true;
    const sources = new Set(strongDocs.map((m) => m.doc.source_type));
    return sources.size >= 2;
  };

  for (const eventClass of EVENT_CLASSES) {
    const matches = classMatches[eventClass.id];
    const classCap = params.max_points_per_event_class
      ? Math.min(eventClass.cap, params.max_points_per_event_class)
      : eventClass.cap;
    const needsConfirm = params.require_confirmation_for_accounting
      && (eventClass.id === 'ACCOUNTING_RESTATEMENT' || eventClass.id === 'FRAUD_OR_INTERNAL_CONTROL');
    const confirmed = needsConfirm ? accountingConfirmed(eventClass.id) : true;
    const downgradeStrong = needsConfirm && !confirmed;

    classScores[eventClass.id] = computeClassScore(
      matches,
      eventClass.severity,
      classCap,
      downgradeStrong
    );
    structuralScores[eventClass.id] = computeClassScore(
      matches,
      eventClass.structural,
      classCap,
      downgradeStrong
    );
  }

  let severity = Object.values(classScores).reduce((sum, v) => sum + v, 0);
  severity = clamp(severity, 0, 100);

  let structuralRisk = Object.values(structuralScores).reduce((sum, v) => sum + v, 0);

  const combinedText = processedDocs.map((d) => d.text).join(' ');

  const classHasStrong = (id: string): boolean => {
    const matches = classMatches[id] || [];
    return matches.some((m) => m.strongMatches.length > 0);
  };

  if (classHasStrong('CREDIT_LIQUIDITY_DISTRESS')
    && hasAny(combinedText, ['going concern', 'covenant breach', 'refinancing'])) {
    structuralRisk += 30;
  }

  const guidanceStrongDocs = classMatches['GUIDANCE_SHOCK_OR_EARNINGS_MISS'] || [];
  const guidanceStrongCount = guidanceStrongDocs.filter((m) => m.strongMatches.length > 0).length;
  if (guidanceStrongCount >= 2
    || (classHasStrong('GUIDANCE_SHOCK_OR_EARNINGS_MISS')
      && hasAny(combinedText, ['demand weakening', 'pricing pressure', 'structural']))) {
    structuralRisk += 20;
  }

  if (classHasStrong('MAJOR_CONTRACT_OR_CUSTOMER_LOSS')
    && hasAny(combinedText, ['largest', 'significant portion'])) {
    structuralRisk += 25;
  }

  if (classHasStrong('ACCOUNTING_RESTATEMENT')
    || (hasAny(combinedText, ['material weakness']) && hasAny(combinedText, ['auditor']))) {
    structuralRisk += 35;
  }

  if (classHasStrong('PRODUCT_RECALL_OR_SAFETY')
    && hasAny(combinedText, ['fatality', 'ban', 'regulator'])) {
    structuralRisk += 25;
  }

  if (classHasStrong('EXECUTIVE_CHANGE')
    && hasAny(combinedText, ['effective immediately', 'terminated'])) {
    structuralRisk += 15;
  }

  if (classHasStrong('REGULATORY_OR_GOVERNMENT_ACTION')
    && hasAny(combinedText, ['consent decree', 'settlement', 'ban', 'license revoked'])) {
    structuralRisk += 25;
  }

  structuralRisk = clamp(structuralRisk, 0, 100);

  const sortedByScore = [...EVENT_CLASSES]
    .map((c) => ({ id: c.id, score: classScores[c.id] }))
    .sort((a, b) => b.score - a.score);

  const macroScore = classScores['MACRO_ROTATION'] || 0;
  const bestNonMacro = sortedByScore.find((c) => c.id !== 'MACRO_ROTATION');

  let primaryEvent = 'NONE';
  if (bestNonMacro && bestNonMacro.score >= params.primary_min_threshold) {
    primaryEvent = bestNonMacro.id;
  } else if (macroScore >= params.macro_threshold) {
    primaryEvent = 'MACRO_ROTATION';
  }

  let shockType: NarrativeShockResult['shock_type'] = 'NONE';
  if (primaryEvent === 'MACRO_ROTATION') {
    shockType = 'MACRO_ROTATION';
  } else if (primaryEvent !== 'NONE') {
    shockType = structuralRisk >= params.structural_threshold ? 'STRUCTURAL_RISK' : 'ONE_OFF';
  } else if (macroScore >= params.macro_threshold) {
    shockType = 'MACRO_ROTATION';
  }

  const mdsPoints: 0 | 10 | 15 =
    shockType === 'ONE_OFF' ? 15 : shockType === 'MACRO_ROTATION' ? 10 : 0;

  const secondary = sortedByScore
    .filter((c) => c.score > 0 && c.id !== primaryEvent)
    .map((c) => ({ event_class: c.id, score: Number(c.score.toFixed(2)) }));

  const topMatches = [...allMatches]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10);

  return {
    ticker: options.ticker,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    primary_event_class: primaryEvent,
    shock_type: shockType,
    severity_0_100: Math.round(severity),
    structural_risk_0_100: Math.round(structuralRisk),
    mds_narrative_shock_points: mdsPoints,
    top_matches: topMatches,
    secondary_event_classes: secondary,
  };
}
