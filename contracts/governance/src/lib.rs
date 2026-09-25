#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]
use nbbs_shared::GovernanceError;
use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol, Val, Vec,
};

pub const DEFAULT_TIMELOCK_SECONDS: u64 = 172_800;
pub const ROUTINE_TIMELOCK_SECONDS: u64 = 86_400; // 24 hours
pub const CRITICAL_TIMELOCK_SECONDS: u64 = 259_200; // 72 hours
pub const EMERGENCY_TIMELOCK_SECONDS: u64 = 3_600; // 1 hour

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[contracttype]
pub enum GovernanceTrack {
    Routine = 0,
    Critical = 1,
    Emergency = 2,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct TrackConfig {
    pub timelock_seconds: u64,
    pub threshold: u32,
    pub min_approval_weight: u128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Checkpoint {
    pub ledger_sequence: u32,
    pub vote_weight: u128,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Signers,
    Threshold,
    TimelockSeconds,
    Proposal(u64),
    ProposalCount,
    Vote(u64, Address),
    Nonce(Address),
    ExecutionNonce(Address),
    AllowList(Address, Symbol),
    MethodMinTrack(Address, Symbol),
    TrackConfig(GovernanceTrack),
    VotingPower(Address),
    CheckpointCount(Address),
    Checkpoint(Address, u32),
    Paused(Address),
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum ProposalStatus {
    Pending,
    Queued,
    Executed,
    Rejected,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub target: Address,
    pub method: Symbol,
    pub args: Vec<Val>,
    pub description: Symbol,
    pub status: ProposalStatus,
    pub approval_count: u32,
    pub veto_count: u32,
    pub created_at: u64,
    pub queued_at: u64,
    pub executed_at: u64,
    pub timelock_seconds: u64,
    pub track: GovernanceTrack,
    pub snapshot_sequence: u32,
    pub approval_weight: u128,
    pub veto_weight: u128,
}

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::Nonce(addr.clone()))
        .unwrap_or(0)
}

fn set_nonce(env: &Env, addr: &Address, nonce: u64) {
    env.storage()
        .instance()
        .set(&DataKey::Nonce(addr.clone()), &nonce);
}

fn check_nonce(env: &Env, addr: &Address, nonce: u64) -> Result<(), GovernanceError> {
    if nonce != get_nonce(env, addr) {
        return Err(GovernanceError::InvalidNonce);
    }
    set_nonce(env, addr, nonce + 1);
    Ok(())
}

fn require_signer(env: &Env, caller: &Address) -> Result<(), GovernanceError> {
    let signers: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::Signers)
        .ok_or(GovernanceError::NotInitialized)?;
    if !signers.contains(caller.clone()) {
        return Err(GovernanceError::NotSigner);
    }
    Ok(())
}

fn get_execution_nonce(env: &Env, target: &Address) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::ExecutionNonce(target.clone()))
        .unwrap_or(0)
}

fn set_execution_nonce(env: &Env, target: &Address, nonce: u64) {
    env.storage()
        .instance()
        .set(&DataKey::ExecutionNonce(target.clone()), &nonce);
}


fn is_emergency_method(env: &Env, method: &Symbol) -> bool {
    *method == Symbol::new(env, "pause")
        || *method == Symbol::new(env, "emergency_pause")
        || *method == Symbol::new(env, "unpause")
        || *method == Symbol::new(env, "emergency_stop")
        || *method == Symbol::new(env, "freeze")
}

fn is_critical_method(env: &Env, method: &Symbol) -> bool {
    *method == Symbol::new(env, "set_admin")
        || *method == Symbol::new(env, "upgrade")
        || *method == Symbol::new(env, "update_admin")
        || *method == Symbol::new(env, "set_track_config")
        || *method == Symbol::new(env, "allow_method")
        || *method == Symbol::new(env, "allow_method_with_track")
        || *method == Symbol::new(env, "remove_from_allow_list")
        || *method == Symbol::new(env, "disallow_method")
        || *method == Symbol::new(env, "set_signers")
        || *method == Symbol::new(env, "set_threshold")
        || *method == Symbol::new(env, "set_method_min_track")
        || *method == Symbol::new(env, "set_risk_parameters")
        || *method == Symbol::new(env, "set_oracle_threshold")
        || *method == Symbol::new(env, "set_deviation_cap")
        || *method == Symbol::new(env, "set_staleness_threshold")
        || *method == Symbol::new(env, "register_credit_type")
        || *method == Symbol::new(env, "set_dispute_bond")
}

fn get_method_min_track(env: &Env, target: &Address, method: &Symbol) -> GovernanceTrack {
    if let Some(track) = env
        .storage()
        .instance()
        .get::<DataKey, GovernanceTrack>(&DataKey::MethodMinTrack(target.clone(), method.clone()))
    {
        return track;
    }
    if is_critical_method(env, method) {
        GovernanceTrack::Critical
    } else if is_emergency_method(env, method) {
        GovernanceTrack::Emergency
    } else {
        GovernanceTrack::Routine
    }
}

fn set_method_min_track(
    env: &Env,
    target: &Address,
    method: &Symbol,
    min_track: GovernanceTrack,
) {
    env.storage().instance().set(
        &DataKey::MethodMinTrack(target.clone(), method.clone()),
        &min_track,
    );
}

fn is_method_allowed(env: &Env, target: &Address, method: &Symbol) -> bool {
    env.storage()
        .instance()
        .get::<DataKey, bool>(&DataKey::AllowList(target.clone(), method.clone()))
        .unwrap_or(false)
}

fn set_method_allowed(env: &Env, target: &Address, method: &Symbol, allowed: bool) {
    env.storage().instance().set(
        &DataKey::AllowList(target.clone(), method.clone()),
        &allowed,
    );
}

fn validate_proposal_callable(
    _env: &Env,
    _target: &Address,
    _method: &Symbol,
    _args: &Vec<Val>,
) -> Result<(), GovernanceError> {
    // NOTE: Full validation of target/method/args is not feasible on-chain in Soroban
    // due to inability to introspect contract interfaces at runtime.
    //
    // Best practice for governance proposals:
    // 1. CLIENT-SIDE PRE-FLIGHT: API layer should simulate the call before submitting propose()
    // 2. DOCUMENTATION: Document the proposal schema required by the target contract
    // 3. TESTING: Ensure critical proposals are tested before governance submission
    //
    // See docs/governance.md for details on the validation strategy.
    // For now, this function is a placeholder for potential future Soroban enhancements.

    Ok(())
}

fn is_signer(env: &Env, address: &Address) -> bool {
    env.storage()
        .instance()
        .get::<_, Vec<Address>>(&DataKey::Signers)
        .map(|signers| signers.contains(address.clone()))
        .unwrap_or(false)
}

fn get_track_config(env: &Env, track: GovernanceTrack) -> TrackConfig {
    env.storage()
        .instance()
        .get(&DataKey::TrackConfig(track))
        .unwrap_or(match track {
            GovernanceTrack::Routine => TrackConfig {
                timelock_seconds: ROUTINE_TIMELOCK_SECONDS,
                threshold: 1,
                min_approval_weight: 0,
            },
            GovernanceTrack::Critical => TrackConfig {
                timelock_seconds: CRITICAL_TIMELOCK_SECONDS,
                threshold: 1,
                min_approval_weight: 0,
            },
            GovernanceTrack::Emergency => TrackConfig {
                timelock_seconds: EMERGENCY_TIMELOCK_SECONDS,
                threshold: 1,
                min_approval_weight: 0,
            },
        })
}

fn record_voting_checkpoint(env: &Env, voter: &Address, new_weight: u128) {
    let current_ledger = env.ledger().sequence();
    let count: u32 = env
        .storage()
        .instance()
        .get(&DataKey::CheckpointCount(voter.clone()))
        .unwrap_or(0);

    if count > 0 {
        let last_idx = count - 1;
        let last_cp: Option<Checkpoint> = env
            .storage()
            .instance()
            .get(&DataKey::Checkpoint(voter.clone(), last_idx));
        if let Some(mut cp) = last_cp {
            if cp.ledger_sequence == current_ledger {
                cp.vote_weight = new_weight;
                env.storage()
                    .instance()
                    .set(&DataKey::Checkpoint(voter.clone(), last_idx), &cp);
                env.storage()
                    .instance()
                    .set(&DataKey::VotingPower(voter.clone()), &new_weight);
                return;
            }
        }
    }

    let cp = Checkpoint {
        ledger_sequence: current_ledger,
        vote_weight: new_weight,
    };
    env.storage()
        .instance()
        .set(&DataKey::Checkpoint(voter.clone(), count), &cp);
    env.storage()
        .instance()
        .set(&DataKey::CheckpointCount(voter.clone()), &(count + 1));
    env.storage()
        .instance()
        .set(&DataKey::VotingPower(voter.clone()), &new_weight);
}

fn get_voting_power_at(env: &Env, voter: &Address, snapshot_sequence: u32) -> u128 {
    let count: u32 = env
        .storage()
        .instance()
        .get(&DataKey::CheckpointCount(voter.clone()))
        .unwrap_or(0);
    if count == 0 {
        return 0;
    }

    let mut low: u32 = 0;
    let mut high: u32 = count;
    let mut best: Option<u128> = None;

    while low < high {
        let mid = low + (high - low) / 2;
        let cp: Checkpoint = env
            .storage()
            .instance()
            .get(&DataKey::Checkpoint(voter.clone(), mid))
            .unwrap();
        if cp.ledger_sequence <= snapshot_sequence {
            best = Some(cp.vote_weight);
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    best.unwrap_or(0)
}

#[contract]
pub struct Governance;

#[contractimpl]
impl Governance {
    pub fn __constructor(env: Env, signers: Vec<Address>, threshold: u32, timelock_seconds: u64) {
        assert!(!signers.is_empty(), "signers must not be empty");
        assert!(
            threshold > 0 && threshold <= signers.len(),
            "threshold must be between 1 and signer count"
        );
        for i in 0..signers.len() {
            for j in (i + 1)..signers.len() {
                assert!(
                    signers.get(i).unwrap() != signers.get(j).unwrap(),
                    "duplicate signer"
                );
            }
        }
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::TimelockSeconds, &timelock_seconds);

        // Configure default risk tier tracks:
        // 1. Routine parameter changes: default configured timelock and standard threshold
        let routine_cfg = TrackConfig {
            timelock_seconds,
            threshold,
            min_approval_weight: 0,
        };
        // 2. Critical parameter changes: elevated threshold and longer timelock
        let critical_threshold = (threshold + 1).min(signers.len());
        let critical_timelock = timelock_seconds.saturating_mul(3) / 2;
        let critical_cfg = TrackConfig {
            timelock_seconds: critical_timelock.max(CRITICAL_TIMELOCK_SECONDS),
            threshold: critical_threshold,
            min_approval_weight: 0,
        };
        // 3. Emergency pause: supermajority approval threshold and short 1-hour timelock
        let emergency_threshold = signers.len().max(threshold);
        let emergency_cfg = TrackConfig {
            timelock_seconds: EMERGENCY_TIMELOCK_SECONDS,
            threshold: emergency_threshold,
            min_approval_weight: 0,
        };

        env.storage().instance().set(
            &DataKey::TrackConfig(GovernanceTrack::Routine),
            &routine_cfg,
        );
        env.storage().instance().set(
            &DataKey::TrackConfig(GovernanceTrack::Critical),
            &critical_cfg,
        );
        env.storage().instance().set(
            &DataKey::TrackConfig(GovernanceTrack::Emergency),
            &emergency_cfg,
        );
    }

    pub fn add_to_allow_list(
        env: Env,
        caller: Address,
        target: Address,
        method: Symbol,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        set_method_allowed(&env, &target, &method, true);

        env.events()
            .publish((Symbol::new(&env, "method_allowed"),), (target, method));

        Ok(())
    }

    pub fn remove_from_allow_list(
        env: Env,
        caller: Address,
        target: Address,
        method: Symbol,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        set_method_allowed(&env, &target, &method, false);

        env.events()
            .publish((Symbol::new(&env, "method_disallowed"),), (target, method));

        Ok(())
    }

    
    pub fn allow_method_with_track(
        env: Env,
        caller: Address,
        target: Address,
        method: Symbol,
        min_track: GovernanceTrack,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        set_method_allowed(&env, &target, &method, true);
        set_method_min_track(&env, &target, &method, min_track);

        env.events()
            .publish((Symbol::new(&env, "method_allowed"),), (target, method));

        Ok(())
    }

    pub fn set_method_min_track(
        env: Env,
        caller: Address,
        target: Address,
        method: Symbol,
        min_track: GovernanceTrack,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        set_method_min_track(&env, &target, &method, min_track);

        Ok(())
    }

    pub fn get_method_min_track(env: Env, target: Address, method: Symbol) -> GovernanceTrack {
        get_method_min_track(&env, &target, &method)
    }

    pub fn is_method_allowed(env: Env, target: Address, method: Symbol) -> bool {
        is_method_allowed(&env, &target, &method)
    }

    pub fn propose(
        env: Env,
        caller: Address,
        target: Address,
        method: Symbol,
        args: Vec<Val>,
        description: Symbol,
        nonce: u64,
    ) -> Result<u64, GovernanceError> {
        Self::propose_with_track(
            env,
            caller,
            target,
            method,
            args,
            description,
            GovernanceTrack::Routine,
            nonce,
        )
    }

    pub fn propose_with_track(
        env: Env,
        caller: Address,
        target: Address,
        method: Symbol,
        args: Vec<Val>,
        description: Symbol,
        track: GovernanceTrack,
        nonce: u64,
    ) -> Result<u64, GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        // Check allow-list: target/method pair must be explicitly allowed
        if !is_method_allowed(&env, &target, &method) {
            return Err(GovernanceError::Unauthorized);
        }

        // Enforce track policy:
        // 1. Emergency track is restricted strictly to permitted emergency circuit-breaker actions
        let is_emergency = is_emergency_method(&env, &method);
        let min_track = get_method_min_track(&env, &target, &method);

        if track == GovernanceTrack::Emergency {
            if !is_emergency && min_track != GovernanceTrack::Emergency {
                return Err(GovernanceError::InvalidTrack);
            }
        }

        // 2. Minimum risk track validation: Critical operations cannot be proposed on Routine or Emergency track
        if min_track == GovernanceTrack::Critical && track != GovernanceTrack::Critical {
            return Err(GovernanceError::InvalidTrack);
        }

        // 3. Emergency-specific methods must use Emergency track
        if min_track == GovernanceTrack::Emergency && track != GovernanceTrack::Emergency {
            return Err(GovernanceError::InvalidTrack);
        }

        validate_proposal_callable(&env, &target, &method, &args)?;

        let track_config = get_track_config(&env, track);

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

        // Pre-proposal snapshot checkpoint: strictly prior to the current ledger sequence to defend against flash-loans
        let snapshot_sequence = env.ledger().sequence().saturating_sub(1);

        let proposal = Proposal {
            id: proposal_id,
            proposer: caller.clone(),
            target: target.clone(),
            method,
            args,
            description,
            status: ProposalStatus::Pending,
            approval_count: 0,
            veto_count: 0,
            created_at: env.ledger().timestamp(),
            queued_at: 0,
            executed_at: 0,
            timelock_seconds: track_config.timelock_seconds,
            track,
            snapshot_sequence,
            approval_weight: 0,
            veto_weight: 0,
        };
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_created"),),
            (proposal_id, target, caller),
        );

        Ok(proposal_id)
    }

    pub fn vote_approve(
        env: Env,
        caller: Address,
        proposal_id: u64,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernanceError::NotPending);
        }

        let is_signer_voter = is_signer(&env, &caller);
        let snapshot_weight = get_voting_power_at(&env, &caller, proposal.snapshot_sequence);

        if !is_signer_voter && snapshot_weight == 0 {
            return Err(GovernanceError::InsufficientVotingPower);
        }

        let vote_key = DataKey::Vote(proposal_id, caller.clone());
        if env
            .storage()
            .instance()
            .get::<_, bool>(&vote_key)
            .unwrap_or(false)
        {
            return Err(GovernanceError::AlreadyVoted);
        }
        env.storage().instance().set(&vote_key, &true);

        let track_config = get_track_config(&env, proposal.track);

        if is_signer_voter {
            proposal.approval_count += 1;
        }
        proposal.approval_weight = proposal.approval_weight.saturating_add(snapshot_weight);

        let count_met = proposal.approval_count >= track_config.threshold;
        let weight_met = track_config.min_approval_weight > 0
            && proposal.approval_weight >= track_config.min_approval_weight;

        if count_met || weight_met {
            proposal.status = ProposalStatus::Queued;
            proposal.queued_at = env.ledger().timestamp();
        }
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "vote_cast"),),
            (proposal_id, caller, proposal.status),
        );

        Ok(())
    }

    pub fn vote_veto(
        env: Env,
        caller: Address,
        proposal_id: u64,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernanceError::NotPending);
        }

        let is_signer_voter = is_signer(&env, &caller);
        let snapshot_weight = get_voting_power_at(&env, &caller, proposal.snapshot_sequence);

        if !is_signer_voter && snapshot_weight == 0 {
            return Err(GovernanceError::InsufficientVotingPower);
        }

        let vote_key = DataKey::Vote(proposal_id, caller.clone());
        if env
            .storage()
            .instance()
            .get::<_, bool>(&vote_key)
            .unwrap_or(false)
        {
            return Err(GovernanceError::AlreadyVoted);
        }
        env.storage().instance().set(&vote_key, &false);

        let track_config = get_track_config(&env, proposal.track);

        if is_signer_voter {
            proposal.veto_count += 1;
        }
        proposal.veto_weight = proposal.veto_weight.saturating_add(snapshot_weight);

        let count_met = proposal.veto_count >= track_config.threshold;
        let weight_met = track_config.min_approval_weight > 0
            && proposal.veto_weight >= track_config.min_approval_weight;

        if count_met || weight_met {
            proposal.status = ProposalStatus::Rejected;
        }
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_rejected"),),
            (proposal_id, caller),
        );

        Ok(())
    }

    pub fn cancel(
        env: Env,
        caller: Address,
        proposal_id: u64,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(GovernanceError::NotPending);
        }

        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_cancelled"),),
            (proposal_id, caller),
        );

        Ok(())
    }

    pub fn execute(
        env: Env,
        caller: Address,
        proposal_id: u64,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Queued {
            return Err(GovernanceError::NotQueued);
        }

        let now = env.ledger().timestamp();
        if now < proposal.queued_at.saturating_add(proposal.timelock_seconds) {
            return Err(GovernanceError::TimelockNotElapsed);
        }

        let exec_nonce = get_execution_nonce(&env, &proposal.target);
        let mut full_args: Vec<Val> = vec![&env, env.current_contract_address().into_val(&env)];
        for arg in proposal.args.iter() {
            full_args.push_back(arg);
        }
        full_args.push_back(exec_nonce.into_val(&env));

        env.invoke_contract::<Val>(&proposal.target, &proposal.method, full_args);
        set_execution_nonce(&env, &proposal.target, exec_nonce + 1);

        if proposal.method == Symbol::new(&env, "pause") {
            env.storage()
                .instance()
                .set(&DataKey::Paused(proposal.target.clone()), &true);
        }

        proposal.status = ProposalStatus::Executed;
        proposal.executed_at = now;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "proposal_executed"),),
            (proposal_id, proposal.target.clone()),
        );

        Ok(())
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<Proposal, GovernanceError> {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(GovernanceError::ProposalNotFound)
    }

    pub fn get_vote(env: Env, proposal_id: u64, signer: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Vote(proposal_id, signer))
            .unwrap_or(false)
    }

    pub fn proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    pub fn get_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or(vec![&env])
    }

    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(1)
    }

    pub fn get_timelock(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::TimelockSeconds)
            .unwrap_or(DEFAULT_TIMELOCK_SECONDS)
    }

    pub fn is_signer(env: Env, address: Address) -> bool {
        env.storage()
            .instance()
            .get::<_, Vec<Address>>(&DataKey::Signers)
            .map(|signers| signers.contains(address))
            .unwrap_or(false)
    }

    pub fn set_track_config(
        env: Env,
        caller: Address,
        track: GovernanceTrack,
        timelock_seconds: u64,
        threshold: u32,
        min_approval_weight: u128,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        let config = TrackConfig {
            timelock_seconds,
            threshold,
            min_approval_weight,
        };

        env.storage()
            .instance()
            .set(&DataKey::TrackConfig(track), &config);

        env.events().publish(
            (Symbol::new(&env, "track_config_updated"),),
            (track, timelock_seconds, threshold),
        );

        Ok(())
    }

    pub fn get_track_config(env: Env, track: GovernanceTrack) -> TrackConfig {
        get_track_config(&env, track)
    }

    pub fn set_voting_power(
        env: Env,
        caller: Address,
        voter: Address,
        weight: u128,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        record_voting_checkpoint(&env, &voter, weight);

        env.events().publish(
            (Symbol::new(&env, "voting_power_updated"),),
            (voter, weight),
        );

        Ok(())
    }

    pub fn get_voting_power_at(env: Env, voter: Address, snapshot_sequence: u32) -> u128 {
        get_voting_power_at(&env, &voter, snapshot_sequence)
    }

    pub fn get_current_voting_power(env: Env, voter: Address) -> u128 {
        get_voting_power_at(&env, &voter, env.ledger().sequence())
    }

    pub fn is_paused(env: Env, target: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused(target))
            .unwrap_or(false)
    }

    pub fn set_paused(
        env: Env,
        caller: Address,
        target: Address,
        paused: bool,
        nonce: u64,
    ) -> Result<(), GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        env.storage()
            .instance()
            .set(&DataKey::Paused(target.clone()), &paused);

        env.events().publish(
            (Symbol::new(&env, "contract_paused"),),
            (target, paused, caller),
        );

        Ok(())
    }

    pub fn propose_emergency_pause(
        env: Env,
        caller: Address,
        target: Address,
        nonce: u64,
    ) -> Result<u64, GovernanceError> {
        caller.require_auth();
        check_nonce(&env, &caller, nonce)?;
        require_signer(&env, &caller)?;

        let pause_sym = Symbol::new(&env, "pause");
        env.storage().instance().set(
            &DataKey::AllowList(target.clone(), pause_sym.clone()),
            &true,
        );

        let track = GovernanceTrack::Emergency;
        let track_config = get_track_config(&env, track);

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

        let snapshot_sequence = env.ledger().sequence().saturating_sub(1);

        let proposal = Proposal {
            id: proposal_id,
            proposer: caller.clone(),
            target: target.clone(),
            method: pause_sym,
            args: vec![&env],
            description: Symbol::new(&env, "emergency_pause"),
            status: ProposalStatus::Pending,
            approval_count: 0,
            veto_count: 0,
            created_at: env.ledger().timestamp(),
            queued_at: 0,
            executed_at: 0,
            timelock_seconds: track_config.timelock_seconds,
            track,
            snapshot_sequence,
            approval_weight: 0,
            veto_weight: 0,
        };
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (Symbol::new(&env, "emergency_pause_proposed"),),
            (proposal_id, caller, target),
        );

        Ok(proposal_id)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, BytesN, IntoVal};

    fn make_signers(env: &Env, count: u32) -> Vec<Address> {
        let mut signers: Vec<Address> = vec![&env];
        for _ in 0..count {
            signers.push_back(Address::generate(env));
        }
        signers
    }

    fn setup() -> (Env, GovernanceClient<'static>, Vec<Address>) {
        let env = Env::default();
        env.mock_all_auths();
        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;
        let contract_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS),
        );
        let client = GovernanceClient::new(&env, &contract_id);
        (env, client, signers)
    }

    fn make_target(env: &Env) -> Address {
        Address::generate(env)
    }

    fn args_for(env: &Env, value: u64) -> Vec<Val> {
        vec![&env, value.into_val(env)]
    }

    #[test]
    fn test_constructor_state() {
        let (_env, client, signers) = setup();
        assert_eq!(client.get_signers(), signers);
        assert_eq!(client.get_threshold(), 3);
        assert_eq!(client.get_timelock(), DEFAULT_TIMELOCK_SECONDS);
        assert!(client.is_signer(&signers.get(0).unwrap()));
        assert!(!client.is_signer(&Address::generate(&_env)));
    }

    #[test]
    fn test_non_signer_cannot_propose() {
        let (env, client, _signers) = setup();
        let outsider = Address::generate(&env);
        let target = make_target(&env);
        let result = client.try_propose(
            &outsider,
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );
        assert_eq!(result, Err(Ok(GovernanceError::NotSigner)));
    }

    #[test]
    fn test_propose_and_quorum_queues() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);
        client.add_to_allow_list(
            &signers.get(4).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &0,
        );

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &args_for(&env, 42),
            &Symbol::new(&env, "desc"),
            &0,
        );
        assert_eq!(proposal_id, 1);

        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.proposer, signers.get(0).unwrap());
        assert_eq!(proposal.target, target);

        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.approval_count, 1);

        client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.approval_count, 2);

        client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Queued);
        assert_eq!(proposal.approval_count, 3);
        assert_eq!(proposal.queued_at, 1_000_000);
    }

    #[test]
    fn test_veto_quorum_rejects() {
        let (env, client, signers) = setup();
        let target = make_target(&env);
        client.add_to_allow_list(
            &signers.get(4).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &0,
        );

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        client.vote_veto(&signers.get(1).unwrap(), &proposal_id, &0);
        client.vote_veto(&signers.get(2).unwrap(), &proposal_id, &0);
        assert_eq!(
            client.get_proposal(&proposal_id).status,
            ProposalStatus::Pending
        );

        client.vote_veto(&signers.get(3).unwrap(), &proposal_id, &0);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Rejected);
        assert_eq!(proposal.veto_count, 3);
    }

    #[test]
    fn test_duplicate_vote_rejected() {
        let (env, client, signers) = setup();
        let target = make_target(&env);
        client.add_to_allow_list(
            &signers.get(2).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &0,
        );

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        let result = client.try_vote_approve(&signers.get(1).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::AlreadyVoted)));

        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.approval_count, 1);
    }

    #[test]
    fn test_vote_on_non_pending_rejected() {
        let (env, client, signers) = setup();
        let target = make_target(&env);
        client.add_to_allow_list(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &0,
        );

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &1,
        );

        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);

        let result = client.try_vote_approve(&signers.get(4).unwrap(), &proposal_id, &0);
        assert_eq!(result, Err(Ok(GovernanceError::NotPending)));
    }

    #[test]
    fn test_cancel_pending_proposal() {
        let (env, client, signers) = setup();
        let target = make_target(&env);
        client.add_to_allow_list(
            &signers.get(3).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &0,
        );

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        client.cancel(&signers.get(1).unwrap(), &proposal_id, &0);
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.status, ProposalStatus::Cancelled);

        let result = client.try_cancel(&signers.get(2).unwrap(), &proposal_id, &0);
        assert_eq!(result, Err(Ok(GovernanceError::NotPending)));
    }

    #[test]
    fn test_execute_requires_timelock_elapsed() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);
        client.add_to_allow_list(
            &signers.get(4).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &0,
        );

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &args_for(&env, 42),
            &Symbol::new(&env, "desc"),
            &0,
        );
        client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);

        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS - 1);
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::TimelockNotElapsed)));

        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS);
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert!(result.is_err());
        assert_ne!(result, Err(Ok(GovernanceError::TimelockNotElapsed)));
    }

    #[test]
    fn test_execute_not_queued_rejected() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);
        client.add_to_allow_list(
            &signers.get(1).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &0,
        );

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS);
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::NotQueued)));
    }

    #[test]
    fn test_execute_rejected_proposal_rejected() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);
        client.add_to_allow_list(
            &signers.get(4).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &0,
        );

        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &0,
        );

        client.vote_veto(&signers.get(1).unwrap(), &proposal_id, &0);
        client.vote_veto(&signers.get(2).unwrap(), &proposal_id, &0);
        client.vote_veto(&signers.get(3).unwrap(), &proposal_id, &0);

        env.ledger()
            .set_timestamp(1_000_000 + DEFAULT_TIMELOCK_SECONDS);
        let result = client.try_execute(&signers.get(0).unwrap(), &proposal_id, &1);
        assert_eq!(result, Err(Ok(GovernanceError::NotQueued)));
    }

    #[test]
    fn test_invalid_nonce() {
        let (env, client, signers) = setup();
        let target = make_target(&env);

        let result = client.try_propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&env, "set_something"),
            &vec![&env],
            &Symbol::new(&env, "desc"),
            &1,
        );
        assert_eq!(result, Err(Ok(GovernanceError::InvalidNonce)));
    }

    #[test]
    fn test_get_nonexistent_proposal() {
        let (_env, client, _signers) = setup();
        let result = client.try_get_proposal(&999);
        assert_eq!(result, Err(Ok(GovernanceError::ProposalNotFound)));
    }

    #[test]
    fn test_executes_end_to_end_against_registry() {
        let env = Env::default();
        env.mock_all_auths();

        let signers = make_signers(&env, 5);
        let threshold: u32 = 3;
        let gov_id = env.register(
            Governance,
            (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS),
        );
        let gov_client = GovernanceClient::new(&env, &gov_id);

        let registry_id = env.register(nbbs_project_registry::ProjectRegistry, (&gov_id,));
        let registry = nbbs_project_registry::ProjectRegistryClient::new(&env, &registry_id);

        let user = Address::generate(&env);
        let mut hash = [0u8; 32];
        hash[31] = 1;
        let metadata = BytesN::from_array(&env, &hash);
        let pid = registry.register_project(
            &user,
            &metadata,
            &Symbol::new(&env, "VCS"),
            &Symbol::new(&env, "US"),
            &0,
        );

        gov_client.add_to_allow_list(
            &signers.get(4).unwrap(),
            &registry_id,
            &Symbol::new(&env, "approve_project"),
            &0,
        );

        let proposal_id = gov_client.propose(
            &signers.get(0).unwrap(),
            &registry_id,
            &Symbol::new(&env, "approve_project"),
            &vec![&env, pid.into_val(&env)],
            &Symbol::new(&env, "approve"),
            &0,
        );
        gov_client.vote_approve(&signers.get(1).unwrap(), &proposal_id, &0);
        gov_client.vote_approve(&signers.get(2).unwrap(), &proposal_id, &0);
        gov_client.vote_approve(&signers.get(3).unwrap(), &proposal_id, &0);

        env.ledger().set_timestamp(DEFAULT_TIMELOCK_SECONDS);
        gov_client.execute(&signers.get(0).unwrap(), &proposal_id, &1);

        let project = registry.get_project(&pid);
        assert_eq!(project.status, nbbs_shared::ProjectStatus::Approved);
    }

    #[test]
    fn test_propose_validation_path_works() {
        // Test that propose() with validation function works without error
        // Full validation is delegated to client-side, but the propose() path should be clean
        let (_env, client, signers) = setup();

        // Simply verify that the validation function doesn't block valid proposals
        // The actual validation guarantees are documented in governance.md
        let target = Address::generate(&_env);
        client.add_to_allow_list(
            &signers.get(1).unwrap(),
            &target,
            &Symbol::new(&_env, "some_method"),
            &0,
        );
        let proposal_id = client.propose(
            &signers.get(0).unwrap(),
            &target,
            &Symbol::new(&_env, "some_method"),
            &vec![&_env],
            &Symbol::new(&_env, "test"),
            &0,
        );

        // If we got here, validation didn't block it (as expected - it's permissive on-chain)
        assert_eq!(proposal_id, 1);
    }

    #[test]
    fn test_propose_disallowed_method_rejected() {
        // Test that proposing a disallowed (target, method) pair is rejected at propose() time
        let (_env, client, signers) = setup();

        let target = Address::generate(&_env);
        let method = Symbol::new(&_env, "dangerous_method");

        // Try to propose without adding to allow-list - should fail
        let result = client.try_propose(
            &signers.get(0).unwrap(),
            &target,
            &method,
            &vec![&_env],
            &Symbol::new(&_env, "attempt"),
            &0,
        );

        // Should be rejected because method is not in allow-list
        assert_eq!(result, Err(Ok(GovernanceError::Unauthorized)));
    }

    #[test]
    fn test_is_method_allowed_query() {
        // Test that is_method_allowed query works
        let (_env, client, signers) = setup();

        let target = Address::generate(&_env);
        let method = Symbol::new(&_env, "test_method");

        // Initially not allowed
        assert!(!client.is_method_allowed(&target, &method));

        // Add to allow-list
        client.add_to_allow_list(&signers.get(0).unwrap(), &target, &method, &0);

        // Now allowed
        assert!(client.is_method_allowed(&target, &method));

        // Remove from allow-list
        client.remove_from_allow_list(&signers.get(1).unwrap(), &target, &method, &0);

        // No longer allowed
        assert!(!client.is_method_allowed(&target, &method));
    }

    #[test]
    fn test_remove_from_allow_list_blocks_proposals() {
        // Test that removing a method from allow-list blocks new proposals
        let (_env, client, signers) = setup();

        let target = Address::generate(&_env);
        let method = Symbol::new(&_env, "removable_method");

        // Add to allow-list
        client.add_to_allow_list(&signers.get(0).unwrap(), &target, &method, &0);

        // First proposal should succeed
        let proposal_id = client.propose(
            &signers.get(1).unwrap(),
            &target,
            &method,
            &vec![&_env],
            &Symbol::new(&_env, "first"),
            &0,
        );
        assert_eq!(proposal_id, 1);

        // Remove from allow-list
        client.remove_from_allow_list(&signers.get(2).unwrap(), &target, &method, &0);

        // Second proposal should fail
        let result = client.try_propose(
            &signers.get(3).unwrap(),
            &target,
            &method,
            &vec![&_env],
            &Symbol::new(&_env, "second"),
            &0,
        );

        assert_eq!(result, Err(Ok(GovernanceError::Unauthorized)));
    }

    #[test]
    fn test_governance_tracks_different_timelocks_and_thresholds() {
        let (env, client, signers) = setup();
        env.ledger().set_timestamp(1_000_000);
        let target = make_target(&env);
        let routine_method = Symbol::new(&env, "routine_action");
        let critical_method = Symbol::new(&env, "set_oracle_threshold");
        let emergency_method = Symbol::new(&env, "pause");

        client.add_to_allow_list(&signers.get(0).unwrap(), &target, &routine_method, &0);
        client.add_to_allow_list(&signers.get(0).unwrap(), &target, &critical_method, &1);
        client.add_to_allow_list(&signers.get(0).unwrap(), &target, &emergency_method, &2);

        // Verify default track configurations
        let routine_cfg = client.get_track_config(&GovernanceTrack::Routine);
        assert_eq!(routine_cfg.timelock_seconds, DEFAULT_TIMELOCK_SECONDS);
        assert_eq!(routine_cfg.threshold, 3);

        let critical_cfg = client.get_track_config(&GovernanceTrack::Critical);
        assert_eq!(critical_cfg.timelock_seconds, CRITICAL_TIMELOCK_SECONDS);
        assert_eq!(critical_cfg.threshold, 4);

        let emergency_cfg = client.get_track_config(&GovernanceTrack::Emergency);
        assert_eq!(emergency_cfg.timelock_seconds, EMERGENCY_TIMELOCK_SECONDS);
        assert_eq!(emergency_cfg.threshold, 5);

        // 1. Propose on Routine track (requires 3 approvals, 24h timelock)
        let routine_pid = client.propose_with_track(
            &signers.get(0).unwrap(),
            &target,
            &routine_method,
            &vec![&env],
            &Symbol::new(&env, "routine_desc"),
            &GovernanceTrack::Routine,
            &3,
        );
        let prop = client.get_proposal(&routine_pid);
        assert_eq!(prop.timelock_seconds, DEFAULT_TIMELOCK_SECONDS);
        assert_eq!(prop.track, GovernanceTrack::Routine);

        client.vote_approve(&signers.get(1).unwrap(), &routine_pid, &0);
        client.vote_approve(&signers.get(2).unwrap(), &routine_pid, &0);
        client.vote_approve(&signers.get(3).unwrap(), &routine_pid, &0);
        assert_eq!(
            client.get_proposal(&routine_pid).status,
            ProposalStatus::Queued
        );

        // 2. Propose on Critical track (requires 4 approvals, 72h timelock)
        let critical_pid = client.propose_with_track(
            &signers.get(0).unwrap(),
            &target,
            &critical_method,
            &vec![&env],
            &Symbol::new(&env, "critical_desc"),
            &GovernanceTrack::Critical,
            &4,
        );
        let prop = client.get_proposal(&critical_pid);
        assert_eq!(prop.timelock_seconds, CRITICAL_TIMELOCK_SECONDS);
        assert_eq!(prop.track, GovernanceTrack::Critical);

        client.vote_approve(&signers.get(1).unwrap(), &critical_pid, &1);
        client.vote_approve(&signers.get(2).unwrap(), &critical_pid, &1);
        client.vote_approve(&signers.get(3).unwrap(), &critical_pid, &1);
        // 3 approvals should NOT queue for Critical track
        assert_eq!(
            client.get_proposal(&critical_pid).status,
            ProposalStatus::Pending
        );

        client.vote_approve(&signers.get(4).unwrap(), &critical_pid, &0);
        // 4th approval queues the Critical proposal
        assert_eq!(
            client.get_proposal(&critical_pid).status,
            ProposalStatus::Queued
        );

        // 3. Propose on Emergency track (requires 5 approvals, 1h timelock)
        let emergency_pid = client.propose_with_track(
            &signers.get(0).unwrap(),
            &target,
            &emergency_method,
            &vec![&env],
            &Symbol::new(&env, "emergency_desc"),
            &GovernanceTrack::Emergency,
            &5,
        );
        let prop = client.get_proposal(&emergency_pid);
        assert_eq!(prop.timelock_seconds, EMERGENCY_TIMELOCK_SECONDS);
        assert_eq!(prop.track, GovernanceTrack::Emergency);

        client.vote_approve(&signers.get(1).unwrap(), &emergency_pid, &2);
        client.vote_approve(&signers.get(2).unwrap(), &emergency_pid, &2);
        client.vote_approve(&signers.get(3).unwrap(), &emergency_pid, &2);
        assert_eq!(
            client.get_proposal(&emergency_pid).status,
            ProposalStatus::Pending
        );

        client.vote_approve(&signers.get(4).unwrap(), &emergency_pid, &1);
        // 4 approvals is still pending because emergency requires 5
        assert_eq!(
            client.get_proposal(&emergency_pid).status,
            ProposalStatus::Pending
        );

        client.vote_approve(&signers.get(0).unwrap(), &emergency_pid, &6);
        // 5th approval reaches supermajority and queues
        assert_eq!(
            client.get_proposal(&emergency_pid).status,
            ProposalStatus::Queued
        );
    }

    #[test]
    fn test_flash_loan_voting_fails_due_to_pre_proposal_snapshot() {
        let (env, client, signers) = setup();
        let target = make_target(&env);
        let method = Symbol::new(&env, "set_something");
        client.add_to_allow_list(&signers.get(0).unwrap(), &target, &method, &0);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let attacker = Address::generate(&env);

        // Configure Critical track to require 1_000_000 voting weight quorum
        client.set_track_config(
            &signers.get(0).unwrap(),
            &GovernanceTrack::Critical,
            &CRITICAL_TIMELOCK_SECONDS,
            &10, // high signer count so weight quorum must be used
            &1_000_000,
            &1,
        );

        // Pre-proposal ledger 100: Alice has 600,000 staked voting power
        env.ledger().set_sequence_number(100);
        client.set_voting_power(&signers.get(0).unwrap(), &alice, &600_000, &2);

        // Pre-proposal ledger 150: Bob has 500,000 staked voting power
        env.ledger().set_sequence_number(150);
        client.set_voting_power(&signers.get(0).unwrap(), &bob, &500_000, &3);

        // Attacker had 10 tokens at ledger 50
        env.ledger().set_sequence_number(50);
        client.set_voting_power(&signers.get(0).unwrap(), &attacker, &10, &4);

        // Ledger 200: Proposal is created
        env.ledger().set_sequence_number(200);
        let pid = client.propose_with_track(
            &signers.get(0).unwrap(),
            &target,
            &method,
            &vec![&env],
            &Symbol::new(&env, "community_prop"),
            &GovernanceTrack::Critical,
            &5,
        );

        let proposal = client.get_proposal(&pid);
        // Snapshot sequence is strictly prior to proposal creation sequence (200 - 1 = 199)
        assert_eq!(proposal.snapshot_sequence, 199);

        // Ledger 201: Attacker executes a flash loan borrowing 50,000,000 tokens
        env.ledger().set_sequence_number(201);
        client.set_voting_power(&signers.get(0).unwrap(), &attacker, &50_000_000, &6);

        // Attacker attempts to vote using their 50M flash-loaned power
        // The contract evaluates their power at snapshot sequence 199, where they had only 10 tokens
        client.vote_approve(&attacker, &pid, &0);

        let prop_after_attacker = client.get_proposal(&pid);
        // Attacker's approval weight is only 10, NOT 50,000,000!
        assert_eq!(prop_after_attacker.approval_weight, 10);
        assert_eq!(prop_after_attacker.status, ProposalStatus::Pending);

        // A totally new address who borrowed via flash loan with 0 pre-snapshot balance fails entirely
        let pure_flash_loaner = Address::generate(&env);
        client.set_voting_power(
            &signers.get(0).unwrap(),
            &pure_flash_loaner,
            &100_000_000,
            &7,
        );
        let res = client.try_vote_approve(&pure_flash_loaner, &pid, &0);
        assert_eq!(res, Err(Ok(GovernanceError::InsufficientVotingPower)));

        // Honest pre-staked voters vote with their snapshot power
        client.vote_approve(&alice, &pid, &0);
        let prop_after_alice = client.get_proposal(&pid);
        assert_eq!(prop_after_alice.approval_weight, 600_010);
        assert_eq!(prop_after_alice.status, ProposalStatus::Pending);

        client.vote_approve(&bob, &pid, &0);
        let prop_after_bob = client.get_proposal(&pid);
        // Total weight is 600_000 + 500_000 + 10 = 1_100_010 >= 1_000_000 quorum!
        assert_eq!(prop_after_bob.approval_weight, 1_100_010);
        assert_eq!(prop_after_bob.status, ProposalStatus::Queued);
    }

    #[test]
    fn test_emergency_pause_flow() {
        let (env, client, signers) = setup();
        let target = make_target(&env);

        // Initially not paused
        assert!(!client.is_paused(&target));

        // Propose emergency pause
        let pid = client.propose_emergency_pause(&signers.get(0).unwrap(), &target, &0);
        let prop = client.get_proposal(&pid);
        assert_eq!(prop.track, GovernanceTrack::Emergency);
        assert_eq!(prop.timelock_seconds, EMERGENCY_TIMELOCK_SECONDS);

        // Emergency requires supermajority of signers (5 out of 5)
        for (i, signer) in signers.iter().enumerate() {
            let s_nonce = if i == 0 { 1 } else { 0 };
            client.vote_approve(&signer, &pid, &s_nonce);
        }

        let queued_prop = client.get_proposal(&pid);
        assert_eq!(queued_prop.status, ProposalStatus::Queued);

        // Direct set_paused / is_paused controls
        client.set_paused(&signers.get(0).unwrap(), &target, &true, &2);
        assert!(client.is_paused(&target));

        client.set_paused(&signers.get(1).unwrap(), &target, &false, &1);
        assert!(!client.is_paused(&target));
    }

    #[test]
    fn test_downgrade_critical_operation_to_routine_rejected() {
        let (env, client, signers) = setup();
        let target = make_target(&env);
        let critical_method = Symbol::new(&env, "set_oracle_threshold");

        client.add_to_allow_list(&signers.get(0).unwrap(), &target, &critical_method, &0);
        assert_eq!(
            client.get_method_min_track(&target, &critical_method),
            GovernanceTrack::Critical
        );

        // Attempting to propose critical operation on Routine track via propose() must fail
        let res_propose = client.try_propose(
            &signers.get(1).unwrap(),
            &target,
            &critical_method,
            &vec![&env],
            &Symbol::new(&env, "downgrade_attempt_1"),
            &0,
        );
        assert_eq!(res_propose, Err(Ok(GovernanceError::InvalidTrack)));

        // Attempting to propose critical operation on Routine track via propose_with_track() must fail
        let res_routine = client.try_propose_with_track(
            &signers.get(1).unwrap(),
            &target,
            &critical_method,
            &vec![&env],
            &Symbol::new(&env, "downgrade_attempt_2"),
            &GovernanceTrack::Routine,
            &0,
        );
        assert_eq!(res_routine, Err(Ok(GovernanceError::InvalidTrack)));

        // Attempting to propose critical operation on Emergency track must also fail
        let res_emergency = client.try_propose_with_track(
            &signers.get(1).unwrap(),
            &target,
            &critical_method,
            &vec![&env],
            &Symbol::new(&env, "emergency_critical_abuse"),
            &GovernanceTrack::Emergency,
            &0,
        );
        assert_eq!(res_emergency, Err(Ok(GovernanceError::InvalidTrack)));

        // Proposing on Critical track succeeds
        let pid = client.propose_with_track(
            &signers.get(1).unwrap(),
            &target,
            &critical_method,
            &vec![&env],
            &Symbol::new(&env, "valid_critical"),
            &GovernanceTrack::Critical,
            &0,
        );
        assert_eq!(pid, 1);
        let prop = client.get_proposal(&pid);
        assert_eq!(prop.track, GovernanceTrack::Critical);
        assert_eq!(prop.timelock_seconds, CRITICAL_TIMELOCK_SECONDS);
    }

    #[test]
    fn test_emergency_track_restricted_to_circuit_breaker() {
        let (env, client, signers) = setup();
        let target = make_target(&env);
        let routine_method = Symbol::new(&env, "routine_update");
        let pause_method = Symbol::new(&env, "pause");

        client.add_to_allow_list(&signers.get(0).unwrap(), &target, &routine_method, &0);
        client.add_to_allow_list(&signers.get(0).unwrap(), &target, &pause_method, &1);

        // Attempting to propose a routine method on the Emergency track fails
        let res = client.try_propose_with_track(
            &signers.get(1).unwrap(),
            &target,
            &routine_method,
            &vec![&env],
            &Symbol::new(&env, "unauthorized_emergency_attempt"),
            &GovernanceTrack::Emergency,
            &0,
        );
        assert_eq!(res, Err(Ok(GovernanceError::InvalidTrack)));

        // Proposing emergency pause on Emergency track succeeds
        let pid = client.propose_with_track(
            &signers.get(1).unwrap(),
            &target,
            &pause_method,
            &vec![&env],
            &Symbol::new(&env, "emergency_pause_action"),
            &GovernanceTrack::Emergency,
            &0,
        );
        assert_eq!(pid, 1);
        let prop = client.get_proposal(&pid);
        assert_eq!(prop.track, GovernanceTrack::Emergency);
        assert_eq!(prop.timelock_seconds, EMERGENCY_TIMELOCK_SECONDS);
    }

    #[test]
    fn test_allow_method_with_track_custom_enforcement() {
        let (env, client, signers) = setup();
        let target = make_target(&env);
        let custom_method = Symbol::new(&env, "custom_action");

        // Allow with explicit Critical track
        client.allow_method_with_track(
            &signers.get(0).unwrap(),
            &target,
            &custom_method,
            &GovernanceTrack::Critical,
            &0,
        );
        assert_eq!(
            client.get_method_min_track(&target, &custom_method),
            GovernanceTrack::Critical
        );

        // Proposing as Routine fails
        let res_routine = client.try_propose_with_track(
            &signers.get(1).unwrap(),
            &target,
            &custom_method,
            &vec![&env],
            &Symbol::new(&env, "routine_attempt"),
            &GovernanceTrack::Routine,
            &0,
        );
        assert_eq!(res_routine, Err(Ok(GovernanceError::InvalidTrack)));

        // Proposing as Critical succeeds
        let pid = client.propose_with_track(
            &signers.get(1).unwrap(),
            &target,
            &custom_method,
            &vec![&env],
            &Symbol::new(&env, "critical_success"),
            &GovernanceTrack::Critical,
            &0,
        );
        assert_eq!(pid, 1);
    }

}
