//! Property tests for default waterfall across partial losses (#616).
//!
//! Verifies conservation, strict seniority payout ordering, reverse-seniority
//! loss absorption, monotonicity across increasing partial losses, idempotent
//! retry behavior, authorization guards, and post-default recovery ordering.

#![cfg(test)]

use proptest::prelude::*;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
struct WaterfallTranche {
    id: String,
    seniority: u8, // 0 = senior, 1 = mezzanine, 2 = junior
    notional: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrancheOutcome {
    id: String,
    seniority: u8,
    notional: u128,
    paid: u128,
    loss_absorbed: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WaterfallSettlement {
    idempotency_key: String,
    outcomes: Vec<TrancheOutcome>,
    total_notional: u128,
    total_paid: u128,
    total_loss: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WaterfallError {
    Unauthorized,
    EmptyTranches,
    DuplicateTrancheId,
    ZeroNotional,
    LossExceedsNotional,
    RecoveryExceedsLoss,
}

fn settle_default_waterfall(
    caller_is_authorized: bool,
    idempotency_key: &str,
    tranches: &[WaterfallTranche],
    partial_loss: u128,
) -> Result<WaterfallSettlement, WaterfallError> {
    if !caller_is_authorized {
        return Err(WaterfallError::Unauthorized);
    }
    if tranches.is_empty() {
        return Err(WaterfallError::EmptyTranches);
    }

    let mut seen = HashSet::new();
    let mut total_notional: u128 = 0;
    for t in tranches {
        if t.notional == 0 {
            return Err(WaterfallError::ZeroNotional);
        }
        if !seen.insert(t.id.clone()) {
            return Err(WaterfallError::DuplicateTrancheId);
        }
        total_notional = total_notional
            .checked_add(t.notional)
            .ok_or(WaterfallError::LossExceedsNotional)?;
    }

    if partial_loss > total_notional {
        return Err(WaterfallError::LossExceedsNotional);
    }

    // Group tranches by seniority descending (junior absorbs loss first).
    let mut sorted = tranches.to_vec();
    sorted.sort_by(|a, b| b.seniority.cmp(&a.seniority).then_with(|| a.id.cmp(&b.id)));

    let mut remaining_loss = partial_loss;
    let mut outcomes = Vec::with_capacity(sorted.len());

    let mut idx = 0;
    while idx < sorted.len() {
        let tier = sorted[idx].seniority;
        let mut end = idx + 1;
        while end < sorted.len() && sorted[end].seniority == tier {
            end += 1;
        }

        let tier_slice = &sorted[idx..end];
        let tier_notional: u128 = tier_slice.iter().map(|t| t.notional).sum();
        let tier_loss = remaining_loss.min(tier_notional);
        remaining_loss -= tier_loss;

        if tier_slice.len() == 1 || tier_loss == 0 || tier_loss == tier_notional {
            for t in tier_slice {
                let loss = if tier_loss == tier_notional {
                    t.notional
                } else {
                    tier_loss.min(t.notional)
                };
                outcomes.push(TrancheOutcome {
                    id: t.id.clone(),
                    seniority: t.seniority,
                    notional: t.notional,
                    paid: t.notional - loss,
                    loss_absorbed: loss,
                });
            }
        } else {
            // Pro-rata loss allocation within equal-seniority tier with deterministic remainder.
            let mut allocated: u128 = 0;
            let mut tier_losses = Vec::with_capacity(tier_slice.len());
            for t in tier_slice {
                let share = (tier_loss * t.notional) / tier_notional;
                allocated += share;
                tier_losses.push(share);
            }
            let mut rem = tier_loss - allocated;
            for (i, t) in tier_slice.iter().enumerate() {
                if rem == 0 {
                    break;
                }
                let room = t.notional - tier_losses[i];
                let extra = rem.min(room);
                tier_losses[i] += extra;
                rem -= extra;
            }
            for (i, t) in tier_slice.iter().enumerate() {
                let loss = tier_losses[i];
                outcomes.push(TrancheOutcome {
                    id: t.id.clone(),
                    seniority: t.seniority,
                    notional: t.notional,
                    paid: t.notional - loss,
                    loss_absorbed: loss,
                });
            }
        }

        idx = end;
    }

    // Sort outcomes in canonical senior-first order for inspection.
    outcomes.sort_by(|a, b| a.seniority.cmp(&b.seniority).then_with(|| a.id.cmp(&b.id)));
    let total_paid: u128 = outcomes.iter().map(|o| o.paid).sum();
    let total_loss: u128 = outcomes.iter().map(|o| o.loss_absorbed).sum();

    Ok(WaterfallSettlement {
        idempotency_key: idempotency_key.to_string(),
        outcomes,
        total_notional,
        total_paid,
        total_loss,
    })
}

fn retry_settlement(
    previous: Option<&WaterfallSettlement>,
    caller_is_authorized: bool,
    idempotency_key: &str,
    tranches: &[WaterfallTranche],
    partial_loss: u128,
) -> Result<WaterfallSettlement, WaterfallError> {
    if !caller_is_authorized {
        return Err(WaterfallError::Unauthorized);
    }
    if let Some(prev) = previous {
        if prev.idempotency_key == idempotency_key {
            return Ok(prev.clone());
        }
    }
    settle_default_waterfall(caller_is_authorized, idempotency_key, tranches, partial_loss)
}

fn apply_recovery(
    caller_is_authorized: bool,
    settlement: &WaterfallSettlement,
    recovery_amount: u128,
) -> Result<WaterfallSettlement, WaterfallError> {
    if !caller_is_authorized {
        return Err(WaterfallError::Unauthorized);
    }
    if recovery_amount > settlement.total_loss {
        return Err(WaterfallError::RecoveryExceedsLoss);
    }

    let mut remaining = recovery_amount;
    let mut outcomes = settlement.outcomes.clone();
    outcomes.sort_by(|a, b| a.seniority.cmp(&b.seniority).then_with(|| a.id.cmp(&b.id)));

    for outcome in &mut outcomes {
        if remaining == 0 {
            break;
        }
        let restore = remaining.min(outcome.loss_absorbed);
        outcome.paid += restore;
        outcome.loss_absorbed -= restore;
        remaining -= restore;
    }

    let total_paid: u128 = outcomes.iter().map(|o| o.paid).sum();
    let total_loss: u128 = outcomes.iter().map(|o| o.loss_absorbed).sum();

    Ok(WaterfallSettlement {
        idempotency_key: settlement.idempotency_key.clone(),
        outcomes,
        total_notional: settlement.total_notional,
        total_paid,
        total_loss,
    })
}

#[test]
fn test_authorization_and_failure_paths() {
    let tranches = vec![
        WaterfallTranche {
            id: "senior".into(),
            seniority: 0,
            notional: 100,
        },
        WaterfallTranche {
            id: "junior".into(),
            seniority: 2,
            notional: 50,
        },
    ];

    assert_eq!(
        settle_default_waterfall(false, "k1", &tranches, 10),
        Err(WaterfallError::Unauthorized)
    );
    assert_eq!(
        settle_default_waterfall(true, "k1", &[], 0),
        Err(WaterfallError::EmptyTranches)
    );
    assert_eq!(
        settle_default_waterfall(true, "k1", &tranches, 151),
        Err(WaterfallError::LossExceedsNotional)
    );

    let dup = vec![tranches[0].clone(), tranches[0].clone()];
    assert_eq!(
        settle_default_waterfall(true, "k1", &dup, 10),
        Err(WaterfallError::DuplicateTrancheId)
    );

    let settled = settle_default_waterfall(true, "k1", &tranches, 40).unwrap();
    let retried = retry_settlement(Some(&settled), true, "k1", &tranches, 40).unwrap();
    assert_eq!(settled, retried);

    assert_eq!(
        apply_recovery(true, &settled, 41),
        Err(WaterfallError::RecoveryExceedsLoss)
    );
}

proptest! {
    #[test]
    fn prop_conservation_and_seniority_under_partial_loss(
        s_notional in 1u128..1_000_000,
        m_notional in 1u128..1_000_000,
        j_notional in 1u128..1_000_000,
        loss_bps in 0u128..=10_000,
    ) {
        let tranches = vec![
            WaterfallTranche { id: "senior".into(), seniority: 0, notional: s_notional },
            WaterfallTranche { id: "mezz".into(), seniority: 1, notional: m_notional },
            WaterfallTranche { id: "junior".into(), seniority: 2, notional: j_notional },
        ];
        let total = s_notional + m_notional + j_notional;
        let loss = (total * loss_bps) / 10_000;

        let settled = settle_default_waterfall(true, "prop", &tranches, loss).unwrap();

        // 1. Conservation
        prop_assert_eq!(settled.total_paid + settled.total_loss, total);
        prop_assert_eq!(settled.total_loss, loss);

        // 2. Strict seniority payout & reverse-seniority loss absorption
        let senior = &settled.outcomes[0];
        let mezz = &settled.outcomes[1];
        let junior = &settled.outcomes[2];

        prop_assert!(senior.paid <= senior.notional);
        prop_assert!(mezz.paid <= mezz.notional);
        prop_assert!(junior.paid <= junior.notional);

        if senior.loss_absorbed > 0 {
            prop_assert_eq!(mezz.paid, 0);
            prop_assert_eq!(junior.paid, 0);
        }
        if mezz.loss_absorbed > 0 {
            prop_assert_eq!(junior.paid, 0);
        }
    }

    #[test]
    fn prop_monotonicity_across_increasing_partial_losses(
        s_notional in 1u128..500_000,
        m_notional in 1u128..500_000,
        j_notional in 1u128..500_000,
        loss_a_bps in 0u128..=10_000,
        delta_bps in 0u128..=10_000,
    ) {
        let tranches = vec![
            WaterfallTranche { id: "senior".into(), seniority: 0, notional: s_notional },
            WaterfallTranche { id: "mezz".into(), seniority: 1, notional: m_notional },
            WaterfallTranche { id: "junior".into(), seniority: 2, notional: j_notional },
        ];
        let total = s_notional + m_notional + j_notional;
        let loss_a = (total * loss_a_bps) / 10_000;
        let loss_b = (total * (loss_a_bps + delta_bps).min(10_000)) / 10_000;

        let res_a = settle_default_waterfall(true, "a", &tranches, loss_a).unwrap();
        let res_b = settle_default_waterfall(true, "b", &tranches, loss_b).unwrap();

        for (oa, ob) in res_a.outcomes.iter().zip(res_b.outcomes.iter()) {
            prop_assert!(ob.paid <= oa.paid);
            prop_assert!(ob.loss_absorbed >= oa.loss_absorbed);
        }
    }

    #[test]
    fn prop_recovery_restores_senior_first_and_conserves(
        s_notional in 1u128..500_000,
        m_notional in 1u128..500_000,
        j_notional in 1u128..500_000,
        loss_bps in 1u128..=10_000,
        recovery_bps in 0u128..=10_000,
    ) {
        let tranches = vec![
            WaterfallTranche { id: "senior".into(), seniority: 0, notional: s_notional },
            WaterfallTranche { id: "mezz".into(), seniority: 1, notional: m_notional },
            WaterfallTranche { id: "junior".into(), seniority: 2, notional: j_notional },
        ];
        let total = s_notional + m_notional + j_notional;
        let loss = (total * loss_bps) / 10_000;
        let settled = settle_default_waterfall(true, "rec", &tranches, loss).unwrap();

        let recovery = (settled.total_loss * recovery_bps) / 10_000;
        let recovered = apply_recovery(true, &settled, recovery).unwrap();

        prop_assert_eq!(recovered.total_paid + recovered.total_loss, total);
        prop_assert_eq!(recovered.total_paid, settled.total_paid + recovery);

        let senior = &recovered.outcomes[0];
        let mezz = &recovered.outcomes[1];
        let junior = &recovered.outcomes[2];
        if senior.paid < senior.notional {
            prop_assert_eq!(mezz.paid, 0);
            prop_assert_eq!(junior.paid, 0);
        }
    }
}
