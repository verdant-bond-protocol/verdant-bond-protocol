/**
 * Deterministic, realistic seed fixtures for local development.
 *
 * These power the Redis-backed seed command (`scripts/seed.ts` / `npm run
 * seed`) so that the dashboard, projects, bonds, marketplace, and oracle
 * pages render meaningful data without requiring deployed Soroban contracts.
 *
 * Every value is stable (fixed UUID-ish addresses and timestamps derived from
 * a fixed base) so the seed is repeatable and idempotent across runs.
 */

const BASE_TS = Date.UTC(2026, 0, 15); // fixed anchor used to derive timestamps
const DAY = 86_400_000;

/** Deterministic pseudo-random sequence (mulberry32) so fixtures never change. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260115);

function wallet(i: number): string {
  // Fake but structurally valid (G + Base32-ish) addresses for local display.
  // Deterministic and distinct per index so every entity gets a unique owner.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ234567';
  let x = (i + 1) * 2654435761;
  let out = 'G';
  for (let k = 0; k < 55; k++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += chars[(x >>> 0) % chars.length];
  }
  return out;
}

export interface SeedProject {
  id: number;
  name: string;
  status: 'Pending' | 'Approved' | 'Rejected' | 'Inactive';
  methodology: string;
  country: string;
  metadataIpfsHash: string;
  ownerAddress: number;
  totalAreaHa: number;
  carbonSequestrationEstimate: number;
  createdAt: number;
  description: string;
  creditType: string;
  blueCarbon: boolean;
}

export interface SeedBond {
  id: number;
  projectId: number;
  name: string;
  faceValue: number;
  couponSchedule: string[];
  creditType: 'Carbon' | 'Biodiversity' | 'Basket' | 'BlueCarbon';
  maturityDate: number;
  maturityStatus: 'Active' | 'Matured';
  totalSupply: number;
  totalSubscribed: number;
  status: 'Active' | 'Matured' | 'Defaulted';
  couponRate: number;
  createdAt: number;
}

export interface SeedOrder {
  id: number;
  seller: number;
  bondId: number;
  amount: number;
  pricePerToken: number;
  quoteAsset: 'USDC' | 'XLM';
  status: 'Open' | 'PartiallyFilled' | 'Filled' | 'Cancelled' | 'Expired';
  createdAt: number;
}

export interface SeedOracleReport {
  id: number;
  projectId: number;
  periodStart: number;
  periodEnd: number;
  carbonSequestered: number;
  methodology: string;
  ipfsHash: string;
  providerAddress: number;
  status: 'Pending' | 'Verified' | 'Challenged' | 'Rejected';
  createdAt: number;
  verifiedAt?: number;
}

export interface SeedUser {
  id: number;
  address: number;
  role: 'admin' | 'developer' | 'investor' | 'oracle-provider';
  name: string;
}

/** Edge-case fixture for issue #302's authorization grant/expiry/renewal flow. */
export interface SeedAuthorization {
  id: string;
  subjectAddress: number;
  scope: string;
  grantedBy: number;
  grantedAt: number;
  expiresAt: number;
  status: 'active' | 'expired' | 'revoked';
  revokedAt?: number;
  revokedBy?: number;
}

export interface SeedDataset {
  users: SeedUser[];
  projects: SeedProject[];
  bonds: SeedBond[];
  orders: SeedOrder[];
  oracleReports: SeedOracleReport[];
  authorizations: SeedAuthorization[];
}

/**
 * Build the full deterministic fixture set.
 *
 * - 4 users covering every role.
 * - 6 projects spanning all project statuses and 4 credit methodologies.
 * - 9 bonds spanning Active/Matured/**Defaulted** and all credit types — bond
 *   9 is the **failed-settlement** edge case (issue #304).
 * - 6 marketplace orders spanning every order status.
 * - 11 oracle reports covering all report statuses: 10 anchored to the fixed
 *   `BASE_TS` story, plus report 11, anchored to `now` minus a long window,
 *   as the **overdue-workflow** edge case — still `Pending` well past when a
 *   report would normally be expected.
 * - 3 authorization grants (issue #302's grant/expiry/renewal model) covering
 *   active, expired-but-uncleaned, and the **revoked-access** edge case.
 * - Bond 5 ("Legacy Amazon Bond (Matured)") is the **historical-records** edge
 *   case: a matured bond created years before the fixture's anchor date.
 *
 * Every id, timestamp, and derived value is either a fixed constant or a
 * single `now` captured once at the top of this function, so two calls in
 * the same process produce byte-identical output (see `seed.service.spec.ts`).
 */
/** `now` anchors the relative dates; the same `now` always gives the same dataset. */
export function buildSeedDataset(now: number = Date.now()): SeedDataset {

  const users: SeedUser[] = [
    { id: 1, address: 1, role: 'admin', name: 'Protocol Admin' },
    { id: 2, address: 2, role: 'developer', name: 'Acacia Developer' },
    { id: 3, address: 3, role: 'investor', name: 'Sophia Investor' },
    { id: 4, address: 4, role: 'oracle-provider', name: 'GeoSat Oracle' },
  ];

  const projects: SeedProject[] = [
    {
      id: 1, name: 'Amazon Reforestation Corridor', status: 'Approved',
      methodology: 'VERRA-VCS', country: 'Brazil',
      metadataIpfsHash: 'QmPjAmbar963', ownerAddress: 2,
      totalAreaHa: 5000, carbonSequestrationEstimate: 125000,
      createdAt: BASE_TS, description: 'Native species reforestation across the southern Amazon arc of deforestation.',
      creditType: 'Carbon', blueCarbon: false,
    },
    {
      id: 2, name: 'Sundarbans Mangrove Restoration', status: 'Approved',
      methodology: 'Plan Vivo', country: 'Bangladesh',
      metadataIpfsHash: 'QmManGrove221', ownerAddress: 2,
      totalAreaHa: 1200, carbonSequestrationEstimate: 48000,
      createdAt: BASE_TS + DAY * 41, description: 'Community-led mangrove restoration in the Sundarbans delta.',
      creditType: 'BlueCarbon', blueCarbon: true,
    },
    {
      id: 3, name: 'Costa Rica Biodiversity Corridor', status: 'Pending',
      methodology: 'CCBS', country: 'Costa Rica',
      metadataIpfsHash: 'QmBiodiv77', ownerAddress: 2,
      totalAreaHa: 800, carbonSequestrationEstimate: 9000,
      createdAt: BASE_TS + DAY * 78, description: 'Connecting fragmented habitats across the Talamanca range.',
      creditType: 'Biodiversity', blueCarbon: false,
    },
    {
      id: 4, name: 'Niger Agroforestry Initiative', status: 'Approved',
      methodology: 'Gold Standard', country: 'Niger',
      metadataIpfsHash: 'QmAgroForest55', ownerAddress: 2,
      totalAreaHa: 3000, carbonSequestrationEstimate: 60000,
      createdAt: BASE_TS + DAY * 15, description: 'Farmer-managed natural regeneration with drought-resistant species.',
      creditType: 'Carbon', blueCarbon: false,
    },
    {
      id: 5, name: 'Blue Carbon Seagrass Meadow', status: 'Rejected',
      methodology: 'Plan Vivo', country: 'Kenya',
      metadataIpfsHash: 'QmSeaGrass9', ownerAddress: 2,
      totalAreaHa: 400, carbonSequestrationEstimate: 15000,
      createdAt: BASE_TS + DAY * 120, description: 'Proposed seagrass restoration; rejected pending boundary review.',
      creditType: 'BlueCarbon', blueCarbon: true,
    },
    {
      id: 6, name: 'Kenya Regenerative Grazing', status: 'Inactive',
      methodology: 'VERRA-VCS', country: 'Kenya',
      metadataIpfsHash: 'QmGrazing31', ownerAddress: 2,
      totalAreaHa: 2500, carbonSequestrationEstimate: 32000,
      createdAt: BASE_TS + DAY * 200, description: 'Rotational grazing pilot currently inactive pending re-verification.',
      creditType: 'Carbon', blueCarbon: false,
    },
  ];

  const coupons = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => new Date(BASE_TS + (i + 1) * 365 * DAY).toISOString().slice(0, 10));

  const bonds: SeedBond[] = [
    {
      id: 1, projectId: 1, name: 'Amazon Reforestation Bond', faceValue: 1_000_000, couponSchedule: coupons(4),
      creditType: 'Carbon', maturityDate: BASE_TS + 365 * DAY * 10, maturityStatus: 'Active',
      totalSupply: 10000, totalSubscribed: 7200, status: 'Active', couponRate: 0.065, createdAt: BASE_TS,
    },
    {
      id: 2, projectId: 2, name: 'Sundarbans Blue Carbon Bond', faceValue: 600_000, couponSchedule: coupons(2),
      creditType: 'BlueCarbon', maturityDate: BASE_TS + 365 * DAY * 5, maturityStatus: 'Active',
      totalSupply: 6000, totalSubscribed: 4800, status: 'Active', couponRate: 0.045, createdAt: BASE_TS + DAY * 41,
    },
    {
      id: 3, projectId: 4, name: 'Niger Agroforestry Bond', faceValue: 400_000, couponSchedule: coupons(3),
      creditType: 'Carbon', maturityDate: BASE_TS + 365 * DAY * 7, maturityStatus: 'Active',
      totalSupply: 4000, totalSubscribed: 1600, status: 'Active', couponRate: 0.05, createdAt: BASE_TS + DAY * 15,
    },
    {
      id: 4, projectId: 3, name: 'Costa Rica Corridor Bond', faceValue: 250_000, couponSchedule: coupons(2),
      creditType: 'Biodiversity', maturityDate: BASE_TS + 365 * DAY * 4, maturityStatus: 'Active',
      totalSupply: 2500, totalSubscribed: 2500, status: 'Active', couponRate: 0.038, createdAt: BASE_TS + DAY * 78,
    },
    {
      id: 5, projectId: 1, name: 'Legacy Amazon Bond (Matured)', faceValue: 500_000, couponSchedule: [],
      creditType: 'Carbon', maturityDate: now - DAY * 30, maturityStatus: 'Matured',
      totalSupply: 5000, totalSubscribed: 5000, status: 'Matured', couponRate: 0.06, createdAt: BASE_TS - 365 * DAY * 3,
    },
    {
      id: 6, projectId: 2, name: 'Mangrove Pioneer Bond', faceValue: 150_000, couponSchedule: coupons(1),
      creditType: 'BlueCarbon', maturityDate: BASE_TS + 365 * DAY * 2, maturityStatus: 'Active',
      totalSupply: 1500, totalSubscribed: 300, status: 'Active', couponRate: 0.03, createdAt: BASE_TS + DAY * 60,
    },
    {
      id: 7, projectId: 4, name: 'Acacia Growth Bond', faceValue: 300_000, couponSchedule: coupons(5),
      creditType: 'Carbon', maturityDate: BASE_TS + 365 * DAY * 15, maturityStatus: 'Active',
      totalSupply: 3000, totalSubscribed: 900, status: 'Active', couponRate: 0.055, createdAt: BASE_TS + DAY * 90,
    },
    {
      id: 8, projectId: 3, name: 'Corridor Conservation Bond', faceValue: 200_000, couponSchedule: coupons(2),
      creditType: 'Biodiversity', maturityDate: BASE_TS + 365 * DAY * 6, maturityStatus: 'Active',
      totalSupply: 2000, totalSubscribed: 2000, status: 'Active', couponRate: 0.04, createdAt: BASE_TS + DAY * 100,
    },
    {
      // Failed-settlement edge case (issue #304): a coupon distribution
      // failed to settle, so the bond is marked Defaulted rather than Active.
      // Matured (past its maturityDate) so no further coupons are expected.
      id: 9, projectId: 6, name: 'Kenya Grazing Bond (Defaulted)', faceValue: 180_000, couponSchedule: coupons(2),
      creditType: 'Carbon', maturityDate: now - DAY * 10, maturityStatus: 'Matured',
      totalSupply: 1800, totalSubscribed: 1800, status: 'Defaulted', couponRate: 0.07, createdAt: BASE_TS + DAY * 205,
    },
  ];

  const mappedBonds = bonds.map((b) => ({
    ...b,
    createdAt: b.createdAt,
    maturityDate: b.maturityDate,
  }));

  const orders: SeedOrder[] = [
    { id: 1, seller: 3, bondId: 1, amount: 500, pricePerToken: 1.02, quoteAsset: 'USDC', status: 'Open', createdAt: now - DAY },
    { id: 2, seller: 3, bondId: 2, amount: 200, pricePerToken: 11.5, quoteAsset: 'XLM', status: 'Open', createdAt: now - DAY * 2 },
    { id: 3, seller: 3, bondId: 3, amount: 400, pricePerToken: 0.99, quoteAsset: 'USDC', status: 'PartiallyFilled', createdAt: now - DAY * 5 },
    { id: 4, seller: 3, bondId: 4, amount: 100, pricePerToken: 1.5, quoteAsset: 'USDC', status: 'Filled', createdAt: now - DAY * 12 },
    { id: 5, seller: 3, bondId: 5, amount: 300, pricePerToken: 0.5, quoteAsset: 'USDC', status: 'Expired', createdAt: now - DAY * 40 },
    { id: 6, seller: 3, bondId: 6, amount: 150, pricePerToken: 2.2, quoteAsset: 'XLM', status: 'Cancelled', createdAt: now - DAY * 30 },
  ];

  const oracleReports: SeedOracleReport[] = [
    { id: 1, projectId: 1, periodStart: BASE_TS + DAY * 100, periodEnd: BASE_TS + DAY * 130, carbonSequestered: 1284, methodology: 'VERRA-VCS', ipfsHash: 'QmRpt1', providerAddress: 4, status: 'Verified', createdAt: BASE_TS + DAY * 131, verifiedAt: BASE_TS + DAY * 132 },
    { id: 2, projectId: 2, periodStart: BASE_TS + DAY * 140, periodEnd: BASE_TS + DAY * 170, carbonSequestered: 942, methodology: 'Plan Vivo', ipfsHash: 'QmRpt2', providerAddress: 4, status: 'Verified', createdAt: BASE_TS + DAY * 171, verifiedAt: BASE_TS + DAY * 172 },
    { id: 3, projectId: 4, periodStart: BASE_TS + DAY * 150, periodEnd: BASE_TS + DAY * 180, carbonSequestered: 2048, methodology: 'Gold Standard', ipfsHash: 'QmRpt3', providerAddress: 4, status: 'Verified', createdAt: BASE_TS + DAY * 181, verifiedAt: BASE_TS + DAY * 182 },
    { id: 4, projectId: 1, periodStart: BASE_TS + DAY * 200, periodEnd: BASE_TS + DAY * 230, carbonSequestered: 1310, methodology: 'VERRA-VCS', ipfsHash: 'QmRpt4', providerAddress: 4, status: 'Challenged', createdAt: BASE_TS + DAY * 231 },
    { id: 5, projectId: 2, periodStart: BASE_TS + DAY * 210, periodEnd: BASE_TS + DAY * 240, carbonSequestered: 980, methodology: 'Plan Vivo', ipfsHash: 'QmRpt5', providerAddress: 4, status: 'Pending', createdAt: BASE_TS + DAY * 241 },
    { id: 6, projectId: 3, periodStart: BASE_TS + DAY * 220, periodEnd: BASE_TS + DAY * 250, carbonSequestered: 310, methodology: 'CCBS', ipfsHash: 'QmRpt6', providerAddress: 4, status: 'Rejected', createdAt: BASE_TS + DAY * 251, verifiedAt: BASE_TS + DAY * 252 },
    { id: 7, projectId: 4, periodStart: BASE_TS + DAY * 260, periodEnd: BASE_TS + DAY * 290, carbonSequestered: 2100, methodology: 'Gold Standard', ipfsHash: 'QmRpt7', providerAddress: 4, status: 'Verified', createdAt: BASE_TS + DAY * 291, verifiedAt: BASE_TS + DAY * 292 },
    { id: 8, projectId: 1, periodStart: BASE_TS + DAY * 300, periodEnd: BASE_TS + DAY * 330, carbonSequestered: 1355, methodology: 'VERRA-VCS', ipfsHash: 'QmRpt8', providerAddress: 4, status: 'Pending', createdAt: BASE_TS + DAY * 331 },
    { id: 9, projectId: 2, periodStart: BASE_TS + DAY * 320, periodEnd: BASE_TS + DAY * 350, carbonSequestered: 1011, methodology: 'Plan Vivo', ipfsHash: 'QmRpt9', providerAddress: 4, status: 'Verified', createdAt: BASE_TS + DAY * 351, verifiedAt: BASE_TS + DAY * 352 },
    { id: 10, projectId: 3, periodStart: BASE_TS + DAY * 340, periodEnd: BASE_TS + DAY * 370, carbonSequestered: 298, methodology: 'CCBS', ipfsHash: 'QmRpt10', providerAddress: 4, status: 'Pending', createdAt: BASE_TS + DAY * 371 },
    // Overdue-workflow edge case (issue #304): still Pending long after the
    // period it covers ended, anchored to `now` (not BASE_TS) so it reads as
    // overdue regardless of when the seed is applied.
    { id: 11, projectId: 4, periodStart: now - DAY * 400, periodEnd: now - DAY * 370, carbonSequestered: 1560, methodology: 'Gold Standard', ipfsHash: 'QmRpt11', providerAddress: 4, status: 'Pending', createdAt: now - DAY * 369 },
  ];

  const authorizations: SeedAuthorization[] = [
    // Active: still within its window.
    { id: 'seed-auth-active', subjectAddress: 2, scope: 'covenant:report:BOND-1', grantedBy: 1, grantedAt: now - DAY * 5, expiresAt: now + DAY * 25, status: 'active' },
    // Expired-but-uncleaned: past its expiry, but the fixture records it as
    // still `active` — exercising the "expired before cleanup runs" case the
    // authorization service's `effectiveStatus`/`cleanupExpired` distinguish.
    { id: 'seed-auth-expired', subjectAddress: 3, scope: 'covenant:vote:BOND-2', grantedBy: 1, grantedAt: now - DAY * 60, expiresAt: now - DAY * 5, status: 'active' },
    // Revoked-access edge case: explicitly withdrawn before its natural expiry.
    { id: 'seed-auth-revoked', subjectAddress: 4, scope: 'oracle:submit:PROJECT-3', grantedBy: 1, grantedAt: now - DAY * 40, expiresAt: now + DAY * 20, status: 'revoked', revokedAt: now - DAY * 10, revokedBy: 1 },
  ];

  return {
    users,
    projects,
    bonds: mappedBonds,
    orders,
    oracleReports,
    authorizations,
  };
}

export function walletFor(addressIndex: number): string {
  return wallet(addressIndex);
}

export { rand };
