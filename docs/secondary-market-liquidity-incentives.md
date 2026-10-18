# Secondary-Market Liquidity Incentives Design

## Overview
This specification details the secondary-market liquidity incentive structure for the Verdant Bond Protocol. The design incentivizes automated market makers (AMMs) and order book market makers to provide continuous liquidity for nature-backed bond tokens without diluting or impinging upon the underlying principal guarantees held in escrow.

## Core Architectural Invariants
1. **Principal Shielding**: Escrowed principal backing nature bonds is held in segregated smart contracts (`contracts/bond-issuer`) and cannot be re-hypothecated or drawn down for secondary liquidity rewards.
2. **Yield-Only Reward Source**: Liquidity provider (LP) rewards are funded solely through Protocol Reserve fees (a 15 bps fee on primary coupon distributions) and dedicated ecosystem growth allocations.
3. **Non-Dilutive Minting**: LP incentive tokens do not increase the outstanding debt or principal obligation of the underlying bond tranche.

## Incentive Structure
- **Staked LP Rewards**: LPs holding `VBD-XLM` LP tokens can stake them in the `dex-router` staking vault to earn yield-boosted rewards.
- **Time-Weighted Liquidity Scoring**: Rewards scale with commitment duration (1x for un-locked, up to 2.5x for 90-day locked LP stakes).
- **Dynamic Fee Rebates**: Active market makers meeting minimum depth and spread criteria (< 1% bid-ask spread) receive fee rebates directly from secondary trading volume.

## Security & Anti-Gaming Controls
- **Flash Loan Protection**: Staked LP positions are subject to a minimum 1-block cooldown before withdrawal to prevent flash-mint reward extraction.
- **Circuit Breaker Integration**: If secondary market trading price drops below 85% of face value, secondary LP reward emissions automatically pause until market stabilization.
