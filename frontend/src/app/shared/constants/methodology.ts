// Canonical methodology codes. Keep in sync with docs/credit-methodology.md
// and api/src/projects/constants/methodology.ts (no cross-package sharing
// exists in this repo, so both copies must be updated together).
export const METHODOLOGY_CODES = ['VERRA-VCS', 'GOLD-STANDARD', 'ACR', 'CAR'] as const;

export type MethodologyCode = (typeof METHODOLOGY_CODES)[number];
