/**
 * Product Type Classifier
 *
 * Multi-layer classification: sourceCategory → URL path → title patterns → tags → "other"
 * Strict for ALL categories — only falls back to "other" when all methods are exhausted.
 */

export type ProductType = 'firearm' | 'ammunition' | 'optics' | 'parts' | 'gear' | 'knives' | 'other';

export interface ClassifierInput {
  title: string;
  url: string;
  tags?: string | null;
  sourceCategory?: string | null;   // raw category from API (Shopify product_type, WooCommerce category names)
}

// ── Layer 1: Source Category Mapping ────────────────────────────────────────
// Maps raw API category strings (Shopify product_type, WooCommerce category.name) to ProductType.
// Order matters: first match wins. More specific patterns go first.

const CATEGORY_MAP: Array<[RegExp, ProductType]> = [
  // Firearms — specific patterns first
  [/\b(rifle|shotgun|handgun|pistol|revolver|firearm|carbine|muzzleloader|receiver)\b/i, 'firearm'],
  // Ammunition
  [/\b(ammunit|ammo|cartridge|shotshell|rimfire|centerfire|reload|brass|primer)\b/i, 'ammunition'],
  // Optics
  [/\b(optic|scope|riflescope|binocular|rangefinder|red[\s-]?dot|holographic|reflex[\s-]?sight|magnifier|monocular|spotting[\s-]?scope)\b/i, 'optics'],
  // Knives (before parts/gear since "blade" can be ambiguous)
  [/\b(kniv|knife|knives|blade|dagger|machete|sword|bayonet|multi[\s-]?tool)\b/i, 'knives'],
  // Parts & Accessories
  [/\b(part|accessor|trigger|barrel|stock|grip|magazine|mag[\s-]?well|bolt|spring|buffer|handguard|rail|muzzle[\s-]?brake|compensator|choke|mount|forend|bipod|sling|holster|case)\b/i, 'parts'],
  // Gear
  [/\b(gear|clothing|apparel|boot|glove|vest|bag|safe|cabinet|cleaning|maintenan|target|ear[\s-]?pro|eye[\s-]?pro|camo|blind|decoy|call|survival|camping|tactical[\s-]?gear)\b/i, 'gear'],
];

function classifyByCategory(sourceCategory: string): ProductType | null {
  for (const [pattern, type] of CATEGORY_MAP) {
    if (pattern.test(sourceCategory)) return type;
  }
  return null;
}

// ── Layer 2: URL Path Classification ────────────────────────────────────────
// Extracts category signals from URL path segments (e.g., /firearms/rifles/, /ammunition/)

const URL_PATH_MAP: Array<[RegExp, ProductType]> = [
  [/\/(firearm|rifle|shotgun|handgun|pistol|revolver|carbine|gun-shop\/firearm|restricted|non-restricted)\b/i, 'firearm'],
  [/\/(ammunit|ammo|cartridge|shotshell|rimfire|centerfire|reload|brass|primer)\b/i, 'ammunition'],
  [/\/(optic|scope|sight|red-dot|rangefinder|binocular|magnifier)\b/i, 'optics'],
  [/\/(kniv|knife|knives|blade|bayonet|machete)\b/i, 'knives'],
  [/\/(part|accessor|trigger|barrel|stock|grip|magazine|handguard|rail|mount|bipod|sling|holster|case|choke)\b/i, 'parts'],
  [/\/(gear|clothing|apparel|boot|glove|vest|bag|safe|cabinet|cleaning|target|protection|camo|tactical-gear)\b/i, 'gear'],
];

function classifyByUrl(url: string): ProductType | null {
  try {
    const path = new URL(url).pathname.toLowerCase();
    for (const [pattern, type] of URL_PATH_MAP) {
      if (pattern.test(path)) return type;
    }
  } catch { /* invalid URL, skip */ }
  return null;
}

// ── Layer 3: Title-Based Classification ─────────────────────────────────────
// The most complex layer — must handle ambiguity carefully.
// Priority: firearm > ammunition > optics > knives > parts > gear > other

// ── Negative contexts: phrases that DEMOTE a firearm match to parts ──
const PARTS_CONTEXT = /\b(parts?\s*kit|barrel\s*only|stock\s*only|grip\s*only|trigger\s*(assembly|group|kit)|conversion\s*kit|replacement|spare|repair|for\s+(the\s+)?(ruger|glock|sig|smith|remington|savage|tikka|benelli|beretta|mossberg|browning|winchester|henry|marlin|cz)\b)/i;

// ── Magazine as primary product: "Magazine" is the noun being sold ──
// Matches: "Rifle Magazine, 22 LR, 10 Rounds", "10rd Magazine", "Pistol Magazine"
const MAGAZINE_PRODUCT = /\bmagazine(?:[\s,]|$)/i;

// ── Firearms: brand+model patterns (expanded with abbreviations and Canadian market brands) ──
const FIREARM_BRAND_MODEL = /\b(ruger\s+(10\/22|1022|mini[\s-]?14|pc[\s-]?carbine|american|precision|mark[\s-]?iv|wrangler|sr[\s-]?\d|no[\s-]?1|hawkeye|scout)|sks(-45)?|type[\s-]?81|wk[\s-]?180|ws[\s-]?mcr|norinco|cz[\s-]?(75|457|600|shadow|bren|scorpion|512|527|550|557)|rem(ington)?[\s-]?(870|700|1100|7600|783|742|597|552|572|11[\s-]?87|v3|versa[\s-]?max)|glock[\s-]?\d{2}|sig[\s-]?(p320|p226|p365|p210|p229|cross|mpx|mcx)|smith[\s-]?.?[\s-]?wesson[\s-]?m[\s&]?p|s[\s&]?w[\s-]?(m[\s&]?p|686|629|500|model[\s-]?\d)|browning[\s-]?(bar|bps|citori|x[\s-]?bolt|buckmark|bl[\s-]?22|a[\s-]?bolt|ab3|maxus|cynergy)|winchester[\s-]?(sxp|model[\s-]?70|sx[34]|super[\s-]?x[\s-]?pump)|benelli[\s-]?(m[24]|super[\s-]?black[\s-]?eagle|sbe|montefeltro|ethos|vinci|nova)|beretta[\s-]?(1301|a400|92[fsx]?|a300|686|dt11|690|694|px4)|mossberg[\s-]?(500|590|940|930|835|maverick|patriot|715|802)|savage[\s-]?(110|mark[\s-]?ii|a22|64[f]?|axis|b22|impulse|stevens|320)|tikka[\s-]?(t[13]x)|henry[\s-]?(lever|big[\s-]?boy|golden[\s-]?boy|long[\s-]?ranger|all[\s-]?weather|frontier|single[\s-]?shot)|marlin[\s-]?(336|1895|model[\s-]?60|795|xt|60ss)|derya[\s-]?tm[\s-]?22|stoeger[\s-]?(m3000|m3500|condor|coach|uplander)|franchi[\s-]?(affinity|instinct)|weatherby[\s-]?(vanguard|mark[\s-]?v|element|orion)|howa[\s-]?\d|bergara[\s-]?(b14|hmr|premier)|stag[\s-]?\d|kodiak[\s-]?(wk|defence)|kriss[\s-]?vector|keltec|kel[\s-]?tec|tavor|iwi|colt|thompson[\s-]?center|tc[\s-]?compass|chiappa[\s-]?(1892|1886|1873|1860|little[\s-]?badger|double[\s-]?badger|la322|rhino|spencer)|lakefield[\s-]?(93|64|mark[\s-]?ii)|springfield[\s-]?(2020|saint|m1a|xd[ms]?|hellcat|waypoint|armory)|m1[\s-]?garand|lee[\s-]?enfield|trench[\s-]?gun|mauser[\s-]?(98|k98|c96)|anschutz|anschütz|sako[\s-]?(85|90|finnfire|trg)|cooey|pardner|hatsan|canuck|churchill[\s-]?(pump|semi|206)|citadel|girsan|canik[\s-]?(tp|sfx|mete|rival)|walther[\s-]?(ppq|pdp|p22|ccp|ppk)|rossi[\s-]?(rs22|gallery|rio[\s-]?bravo)|taurus[\s-]?(g[23]|th[49]|judge|tracker|raging)|zastava[\s-]?(m70|m85|m91|zpap)|tokarev[\s-]?(tkx|ta[\s-]?\d)|csa[\s-]?(sa[\s-]?vz|vz)|ata[\s-]?arms|escort[\s-]?(slugger|field|evo)|typhoon[\s-]?f12|mav[\s-]?\d{2})\b/i;

const FIREARM_GENERIC = /\b(rifle|shotgun|pistol|revolver|carbine|musket|muzzleloader|lever[\s-]?action|bolt[\s-]?action|semi[\s-]?auto(matic)?|pump[\s-]?action|over[\s-]?under|side[\s-]?by[\s-]?side|break[\s-]?action|single[\s-]?shot|double[\s-]?barrel|trench[\s-]?gun)\b/i;

// Words that when combined with caliber suggest it's a firearm, not ammo
const FIREARM_CALIBER_CONTEXT = /\b(rifle|shotgun|pistol|carbine|bolt|lever|pump|semi|break|barrel(ed)?[\s-]?action)\b/i;

// Barrel length in title (e.g., 24″, 20"BBL, 18.5" barrel) — strong firearm indicator
const BARREL_LENGTH_PATTERN = /\b\d{1,2}(\.\d)?[\s-]?["″'']([\s-]?(bbl|barrel))?\b/i;

// ── Ammunition patterns ──
const AMMO_STRONG = /\b(ammunition|ammo\b|cartridge|shotshell|buckshot|birdshot|slug[\s-]?(round|ammo|shell)|fmj|jhp|hp\b|soft[\s-]?point|hollow[\s-]?point|ballistic[\s-]?tip|boat[\s-]?tail|rounds?\s*$|box[\s-]?of[\s-]?\d|case[\s-]?of[\s-]?\d|\d+[\s-]?rds?\b|\d+[\s-]?rnds?\b|\d+[\s-]?box\b)|\d+\s*gr(?:ain)?s?\b/i;
const AMMO_CALIBER_ONLY = /\b(\d+[\s-]?(mm|cal|gauge|ga)\b|\.\d+|22[\s-]?lr|222[\s-]?rem|223[\s-]?rem|308[\s-]?win|5\.56|7\.62|9mm|45[\s-]?acp|6\.5[\s-]?creedmoor|300[\s-]?win|300[\s-]?wsm|270[\s-]?win|30[\s-]?06|7mm[\s-]?rem|338[\s-]?lapua|50[\s-]?bmg|17[\s-]?hmr|22[\s-]?wmr|7\.62x39|7\.62x54|5\.45x39|7x57|8mm[\s-]?mauser|\.?45[\s-]?70|\.?30[\s-]?30|\.?243[\s-]?win|\.?6mm|\.?204[\s-]?ruger|\.?22[\s-]?250|\.?25[\s-]?06|\.?257[\s-]?roberts|\.?35[\s-]?rem|\.?450[\s-]?bushmaster|\.?350[\s-]?legend)\b/i;
// Ammo brands — when combined with caliber/grain, strong ammo signal
const AMMO_BRANDS = /\b(federal|hornady|winchester[\s-]?super[\s-]?x|remington[\s-]?core|cci|fiocchi|pmc|sellier|norma|prvi[\s-]?partizan|barnaul|tul[\s-]?ammo|aguila|blazer|speer|nosler|barnes|berger|sierra|lapua|herter|dominion|challenger|estate|rio[\s-]?ammo|kent[\s-]?cartridge)\b/i;

// ── Optics patterns ──
const OPTICS_PATTERN = /\b(scope|riflescope|red[\s-]?dot|holographic[\s-]?sight|reflex[\s-]?sight|magnifier|binocular|rangefinder|spotting[\s-]?scope|monocular|prism[\s-]?sight|lpvo|acog|eotech|aimpoint|holosun|vortex[\s-]?(viper|crossfire|strike[\s-]?eagle|diamondback|razor|pst)|leupold|nikon[\s-]?(monarch|prostaff|buckmaster)|bushnell|burris|nightforce|trijicon|primary[\s-]?arms|swampfox|sig[\s-]?romeo|sig[\s-]?juliet|riton|hawke|meopta|steiner|zeiss|swarovski|maven|tract)\b/i;

// Only match optics brand when clearly a sight product (not a firearm with that brand)
const OPTICS_PRODUCT_WORDS = /\b(scope|sight|dot|magnif|reticle|moa|mrad|bdc|illuminat|turret|objective|eyepiece|eye[\s-]?relief)\b/i;

// Magnification pattern (e.g., 3-9x40, 4-16x50, 1-6x24, 6x42)
const MAGNIFICATION_PATTERN = /\b\d{1,2}[\s-]?(-\d{1,2})?[\s-]?x[\s-]?\d{2,3}\b/i;

// ── Knives patterns ──
const KNIVES_PATTERN = /\b(knife|knives|blade|dagger|machete|bayonet|fixed[\s-]?blade|folding[\s-]?knife|pocket[\s-]?knife|karambit|bowie|kukri|tanto|benchmade|spyderco|kershaw|cold[\s-]?steel|morakniv|ka[\s-]?bar|ontario[\s-]?knife|gerber|leatherman|buck[\s-]?knife|buck[\s-]?\d{3}|swiss[\s-]?army|victorinox|multi[\s-]?tool)\b/i;

// ── Parts patterns (expanded with individual component names from marstar etc.) ──
const PARTS_PATTERN = /\b(magazine|mag\b|trigger|barrel|stock|grip|handguard|rail|mount|ring|base|bipod|sling|holster|case[\s-]?(hard|soft|gun|rifle|pistol)|choke|muzzle[\s-]?brake|flash[\s-]?hider|suppressor|silencer|compensator|forend|forearm|butt[\s-]?pad|butt[\s-]?plate|recoil[\s-]?pad|recoil[\s-]?spring|cheek[\s-]?riser|speed[\s-]?loader|loader|stripper[\s-]?clip|snap[\s-]?cap|dummy[\s-]?round|chamber[\s-]?flag|bore[\s-]?sight|laser|flashlight|weapon[\s-]?light|pic[\s-]?rail|picatinny|m[\s-]?lok|keymod|qd[\s-]?mount|scope[\s-]?ring|scope[\s-]?mount|scope[\s-]?base|adapter|insert|spacer|shim|pin|detent|selector|safety[\s-]?(lever|switch)|bolt[\s-]?release|charging[\s-]?handle|dust[\s-]?cover|gas[\s-]?block|gas[\s-]?tube|buffer|extractor|ejector|firing[\s-]?pin|sear[\s-]?bar|sear\b|hammer[\s-]?(roll|pin|spring|strut)|main[\s-]?spring|plunger|locking[\s-]?bolt|aperture|rear[\s-]?sight|front[\s-]?sight|sight[\s-]?leaf|sight[\s-]?protector|mag[\s-]?release|change[\s-]?lever|retaining|d[ée]tente|slide[\s-]?assembly|guide[\s-]?rod|grips?\s+(gi|wood|rubber|polymer|plastic|stainless)|bullet[\s-]?guide|main[\s-]?spring[\s-]?cap|tripod[\s-]?bracket)\b/i;

// ── Gear patterns ──
const GEAR_PATTERN = /\b(cleaning[\s-]?kit|bore[\s-]?snake|gun[\s-]?oil|solvent|lubricant|patch(es)?|rod|jag|brush|mop|gun[\s-]?safe|gun[\s-]?cabinet|gun[\s-]?rack|gun[\s-]?sock|gun[\s-]?rug|gun[\s-]?slip|gun[\s-]?vise|gun[\s-]?vice|ear[\s-]?(muff|plug|pro)|muff\b|eye[\s-]?pro|shoot[\s-]?glass|safety[\s-]?glass(es)?|hearing[\s-]?protect|eye[\s-]?protect|target|clay|trap|shooting[\s-]?mat|shooting[\s-]?rest|shooting[\s-]?bag|range[\s-]?bag|ammo[\s-]?can|ammo[\s-]?box|speed[\s-]?bag|shell[\s-]?holder|shell[\s-]?pouch|cart[\s-]?bag|vest|camo|decoy|call|game[\s-]?call|trail[\s-]?cam|hunting[\s-]?boot|hunting[\s-]?cloth|blaze[\s-]?orange|ghillie|crossbow|hoppe'?s|gun[\s-]?cleaning|screwdriver[\s-]?set|gunsmith|reticle[\s-]?level|steel[\s-]?plate|gong|plate[\s-]?hanger|tourniquet|bleeding[\s-]?control|ear[\s-]?plug|earplug|lockdown|gun[\s-]?lock)\b/i;

// ── Reloading: classified as ammunition (it's ammo-making) ──
const RELOADING_PATTERN = /\b(reload|reloading|brass|primer|powder|die[\s-]?set|shell[\s-]?holder|press|tumbler|case[\s-]?trim|neck[\s-]?sizer|full[\s-]?length[\s-]?die|bullet[\s-]?mold|bullet[\s-]?puller|case[\s-]?gauge|hand[\s-]?prime|swage|rcbs|lee[\s-]?(precision|pro[\s-]?1000|breech[\s-]?lock|classic|collet|factory|pacesetter|rgb)|hornady[\s-]?(lock[\s-]?n[\s-]?load|custom[\s-]?grade)|redding|dillon|lyman|forster|frankford[\s-]?arsenal)\b/i;

function classifyByTitle(title: string, url: string): ProductType | null {
  const slug = extractSlug(url);

  // Check for parts context first — e.g., "Ruger 10/22 Parts Kit" should be parts, not firearm
  const hasPartsContext = PARTS_CONTEXT.test(title);

  // 1. Reloading equipment/supplies → ammunition
  if (RELOADING_PATTERN.test(title)) return 'ammunition';

  // 2. Firearms — strict matching
  if (!hasPartsContext) {
    // Magazine as primary product — "Rifle Magazine", "10 Round Pistol Magazine"
    // Must check BEFORE firearm generic words since "Rifle"/"Pistol" would match
    if (MAGAZINE_PRODUCT.test(title)) return 'parts';

    // Brand+model is strong signal
    if (FIREARM_BRAND_MODEL.test(title)) {
      // But check if it's actually an optic/part FOR a firearm
      if (OPTICS_PRODUCT_WORDS.test(title)) return 'optics';
      if (MAGNIFICATION_PATTERN.test(title)) return 'optics';
      if (PARTS_PATTERN.test(title) && !FIREARM_GENERIC.test(title) && !BARREL_LENGTH_PATTERN.test(title)) return 'parts';
      return 'firearm';
    }
    // Generic firearm words (rifle, shotgun, pistol, etc.)
    if (FIREARM_GENERIC.test(title)) {
      if (OPTICS_PRODUCT_WORDS.test(title) && /scope|sight/i.test(title)) return 'optics';
      return 'firearm';
    }
    // Barrel length in title (e.g., 24″, 20"BBL) with caliber — usually a firearm listing
    if (BARREL_LENGTH_PATTERN.test(title) && AMMO_CALIBER_ONLY.test(title)) {
      return 'firearm';
    }
  }

  // 3. Optics — magnification pattern is a strong standalone signal
  if (MAGNIFICATION_PATTERN.test(title)) return 'optics';
  if (OPTICS_PATTERN.test(title) && OPTICS_PRODUCT_WORDS.test(title)) return 'optics';
  // Pure optics brand without product word — still optics if no other signal
  if (/\b(eotech|aimpoint|holosun|trijicon|nightforce|swampfox|primary[\s-]?arms)\b/i.test(title)
    && !FIREARM_BRAND_MODEL.test(title)) return 'optics';

  // 4. Knives
  if (KNIVES_PATTERN.test(title)) return 'knives';

  // 5. Ammunition — check title + slug
  if (AMMO_STRONG.test(title)) return 'ammunition';
  // Caliber + ammo brand → ammunition
  if (AMMO_CALIBER_ONLY.test(title) && AMMO_BRANDS.test(title)) return 'ammunition';
  // Caliber in title without firearm context with grain weight → ammunition
  if (AMMO_CALIBER_ONLY.test(title) && !FIREARM_CALIBER_CONTEXT.test(title) && !hasPartsContext) {
    if (/\b\d{2,3}[\s-]?(gr|grain)\b/i.test(title)) return 'ammunition';
  }

  // 6. Parts
  if (PARTS_PATTERN.test(title)) return 'parts';
  if (hasPartsContext) return 'parts';

  // 7. Gear
  if (GEAR_PATTERN.test(title)) return 'gear';

  // 8. Check slug for additional signals
  if (slug) {
    if (/rifle|shotgun|pistol|revolver|carbine/.test(slug) && !hasPartsContext) return 'firearm';
    if (/ammo|ammunition|cartridge/.test(slug)) return 'ammunition';
    if (/scope|optic|sight|red-dot/.test(slug)) return 'optics';
    if (/knife|knives|blade/.test(slug)) return 'knives';
  }

  return null;
}

// ── Layer 4: Tags Classification ────────────────────────────────────────────

function classifyByTags(tags: string): ProductType | null {
  // Tags are comma-separated, treat as category-like text
  return classifyByCategory(tags);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractSlug(url: string): string {
  try {
    const path = new URL(url).pathname.toLowerCase();
    // Get the last meaningful segment (product slug)
    const segments = path.split('/').filter(Boolean);
    return segments[segments.length - 1] || '';
  } catch { return ''; }
}

// ── Main Classifier ─────────────────────────────────────────────────────────

export function classifyProduct(input: ClassifierInput): ProductType {
  // Layer 1: Source category (strongest signal — direct from API taxonomy)
  if (input.sourceCategory) {
    const result = classifyByCategory(input.sourceCategory);
    if (result) return result;
  }

  // Layer 2: URL path (category pages carry strong signal)
  const urlResult = classifyByUrl(input.url);
  if (urlResult) return urlResult;

  // Layer 3: Title-based pattern matching (most products go through here)
  const titleResult = classifyByTitle(input.title, input.url);
  if (titleResult) return titleResult;

  // Layer 4: Tags (Shopify tags, comma-separated keywords)
  if (input.tags) {
    const tagResult = classifyByTags(input.tags);
    if (tagResult) return tagResult;
  }

  // All methods exhausted
  return 'other';
}

/**
 * Batch classify — annotates products with productType.
 * Only classifies if productType is not already set.
 */
export function classifyProducts<T extends ClassifierInput & { productType?: ProductType | null }>(
  products: T[],
): T[] {
  for (const p of products) {
    if (!p.productType) {
      (p as any).productType = classifyProduct(p);
    }
  }
  return products;
}
