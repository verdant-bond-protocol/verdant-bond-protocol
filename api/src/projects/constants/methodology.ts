// Canonical methodology codes and their credit conversion factors.
// Keep in sync with docs/credit-methodology.md and
// frontend/src/app/shared/constants/methodology.ts (no cross-package
// sharing exists in this repo, so both copies must be updated together).
export const VALID_METHODOLOGY_CODES = ['VERRA-VCS', 'GOLD-STANDARD', 'ACR', 'CAR'] as const;

export type MethodologyCode = (typeof VALID_METHODOLOGY_CODES)[number];
