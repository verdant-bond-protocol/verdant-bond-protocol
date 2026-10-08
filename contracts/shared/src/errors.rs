use soroban_sdk::contracterror;

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum BondError {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidNonce = 3,
    BondNotFound = 4,
    BondAlreadyMatured = 5,
    InsufficientSupply = 6,
    ZeroAmount = 7,
    ProjectNotApproved = 8,
    Overflow = 9,
    ReportNotVerified = 10,
    InvalidReport = 11,
    InvalidSupply = 12,
    RedemptionUnderfunded = 13,
    IncompatibleMethodologyCreditType = 14,
    /// A report's performance change is outside the documented bounds; coupon
    /// distribution is paused pending dispute resolution (#186).
    PerformanceFlagged = 15,
    /// Fewer independent verifiers than the coupon-level minimum (#186).
    InsufficientAttestations = 16,
    /// Coupon writes are paused while a migration window is open (#188).
    MigrationInProgress = 17,
    /// Oracle feed is stale beyond threshold 2 requiring manual intervention (#192).
    OracleStaleManualInterventionRequired = 18,
    /// Coupon distribution is frozen because the project has an active dispute (#193).
    ProjectDisputedAndFrozen = 19,
    /// Waterfall priorities or balances are invalid.
    InvalidWaterfall = 20,
    /// A holder already claimed this priority from this waterfall settlement.
    WaterfallAlreadyClaimed = 21,
    /// Requested issuer balance checkpoint is newer than the stored snapshot.
    InvalidBalanceSnapshot = 22,
    RedemptionQueueRequired = 23,
    DuplicateRedemptionRequest = 24,
    InvalidRedemptionBudget = 25,
    AuctionRequired = 26,
    InvalidAuction = 27,
    AuctionClosed = 28,
    SubscriptionIneligible = 29,
    IdentityCapExceeded = 30,
    InvalidCovenant = 31,
    InvalidEquivalence = 32,
    UnknownEquivalence = 33,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum OracleError {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidNonce = 3,
    ProviderNotFound = 4,
    ProviderAlreadyExists = 5,
    ReportNotFound = 6,
    ReportAlreadyVerified = 7,
    ChallengeWindowExpired = 8,
    InsufficientStake = 9,
    InvalidSignature = 10,
    InvalidResolution = 11,
    OverlappingReportPeriod = 12,
    /// Fewer reporting oracle sources than required minimum quorum (#195).
    InsufficientQuorum = 13,
    /// Oracle reporting timestamp exceeds staleness threshold (#192).
    OracleStale = 14,
    /// Bond posted to open a dispute is below minimum requirement (#193).
    DisputeBondInsufficient = 15,
    /// Project is currently subject to an active dispute (#193).
    ProjectDisputed = 16,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum DEXError {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidNonce = 3,
    OrderNotFound = 4,
    OrderAlreadyFilled = 5,
    InsufficientBalance = 6,
    SelfBuyNotAllowed = 7,
    OrderExpired = 8,
    ZeroAmount = 9,
    InsufficientFunds = 10,
    Overflow = 11,
    NoPriceData = 12,
    InvalidMarketConfig = 13,
    MarketNotConfigured = 14,
    InvalidOraclePrice = 15,
    OracleZeroVolume = 16,
    OracleLowVolume = 17,
    OracleStale = 18,
    OraclePaused = 19,
    PriceDeviationExceeded = 20,
    LedgerVolumeExceeded = 21,
    InvalidCommitment = 22,
    RevealTooEarly = 23,
    RevealWindowClosed = 24,
    TransferPreconditionFailed = 40,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum RegistryError {
    NotInitialized = 1,
    Unauthorized = 2,
    ProjectNotFound = 3,
    ProjectAlreadyExists = 4,
    InvalidStatusTransition = 5,
    InvalidNonce = 6,
    InvalidArgument = 7,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum CreditError {
    NotInitialized = 1,
    Unauthorized = 2,
    InsufficientCredits = 3,
    AlreadyRetired = 4,
    InvalidNonce = 5,
    NotAHolder = 6,
    InvalidCertificate = 7,
    InvalidCreditType = 8,
}

#[derive(Clone, Debug, PartialEq)]
#[contracterror]
pub enum GovernanceError {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidNonce = 3,
    NotSigner = 4,
    ProposalNotFound = 5,
    AlreadyVoted = 6,
    NotPending = 7,
    TimelockNotElapsed = 8,
    NotQueued = 9,
    AlreadyExecuted = 10,
    InvalidTrack = 11,
    InsufficientVotingPower = 12,
    QuorumNotReached = 13,
}
