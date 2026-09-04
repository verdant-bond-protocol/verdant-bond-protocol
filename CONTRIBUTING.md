# Contributing to Verdant Bond Protocol

Thank you for your interest in contributing! We welcome contributions from smart contract engineers, climate scientists, financial modelers, oracle architects, and frontend developers.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Code Conventions](#code-conventions)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)
- [Security Disclosures](#security-disclosures)
- [Getting Help](#getting-help)

## Code of Conduct

This project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). All participants are expected to uphold its principles.

## Getting Started

### Prerequisites

- **Node.js** `v18+` and **npm** `v9+`
- **Rust** (stable toolchain) and **Cargo**
- **Soroban CLI** — `cargo install --locked soroban-cli`
- A funded **Stellar testnet account**

### Local Setup

```bash
# Clone the repository
git clone https://github.com/prissca/verdant-bond-protocol.git
cd verdant-bond-protocol

# Copy environment template
cp .env.example api/.env
# Edit api/.env with testnet values

# Install dependencies
cd api && npm install && cd ..
cd frontend && npm install && cd ..

# Build and test contracts
cd contracts && cargo build --release && cargo test && cd ..
```

## Contributor Domain Map

Hard issues are labeled with domain tags that route contributors to the right files, commands, and maintainers. Use this map to know where to focus your efforts.

| Label | Domain | Target Files | Test Commands | Maintainers |
|-------|--------|--------------|---------------|-------------|
| `hard:contract` | Contract (Rust/Soroban) | `contracts/*/src/lib.rs`, `contracts/shared/` | `cargo test -p <contract>`, `cargo test --all` | `@core-contracts` |
| `hard:api` | API (NestJS) | `api/src/**/*`, `api/src/seed/` | `npm run test`, `npm run test:e2e` | `@api-team` |
| `hard:frontend` | Frontend (Angular) | `frontend/src/**/*` | `ng test`, `ng e2e` | `@ui-team` |
| `hard:oracle` | Oracle (adapters + consumer) | `oracle/`, `api/src/oracle/`, `contracts/oracle-consumer/` | `cd oracle && npm test`, `cargo test -p oracle-consumer` | `@oracle-team` |
| `hard:ops` | Ops/DevOps | `.github/workflows/`, `scripts/`, `docs/` | `npm run lint`, `cargo clippy` | `@maintainers` |

## Project Structure

```
verdant-bond-protocol/
├── contracts/            # Soroban smart contracts (Rust)
│   ├── bond-issuer/
│   ├── coupon-engine/
│   ├── oracle-consumer/
│   ├── dex-router/
│   ├── project-registry/
│   ├── credit-retirement/
│   └── shared/           # Shared types and errors
├── api/                  # NestJS backend
│   └── src/
│       ├── bonds/
│       ├── oracle/
│       ├── projects/
│       ├── marketplace/
│       ├── auth/
│       └── stellar/
├── frontend/             # Angular application
├── oracle/               # Oracle adapter scripts
├── ipfs/                 # IPFS utilities & schemas
├── scripts/              # Deployment & migration scripts
├── docs/                 # Documentation
└── .github/              # CI, issue templates, PR template
```

## Development Workflow

1. **Fork** the repository
2. **Create a feature branch:** `git checkout -b feat/your-feature-name`
3. **Make changes** following the code conventions below
4. **Write tests** for new functionality
5. **Run the test suite** locally
6. **Commit** using conventional commits (see below)
7. **Push** and open a **Pull Request** against `main`

### Branch Naming

- `feat/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation changes
- `chore/description` — Maintenance, CI, refactoring
- `security/description` — Security fixes

### Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat(contract): add nonce-based replay protection to BondIssuer
fix(oracle): correct challenge window calculation
docs(readme): expand oracle security section
chore(ci): add cargo-audit to workflow
```

## Code Conventions

### Rust / Soroban Contracts

- Run `cargo clippy --all-targets -- -D warnings` before committing
- Run `cargo fmt` to format code
- Every public function must have at least one unit test
- Use `checked_add` / `checked_sub` for arithmetic
- Follow existing patterns in `contracts/shared/src/types.rs`

### TypeScript / NestJS API

- Run `npm run lint` before committing
- Use `class-validator` DTOs for request validation
- Services should be injectable and testable
- Controllers should be thin — delegate logic to services

### Angular Frontend

- Run `npm run lint` before committing
- Use Angular reactive forms for user input
- Follow the existing component structure in `frontend/src/app/shared/`

### Accessibility Checklist

- Confirm wallet, project creation, bond detail, marketplace, and claim flows are usable with keyboard navigation only.
- Ensure every interactive control has a visible focus state and an accessible name.
- Tie validation errors to their fields with `aria-describedby`, and announce form-level failures with `role="alert"` or `aria-live`.
- Verify dialogs, menus, and dropdowns can be opened, used, and dismissed without losing focus.
- Add or update automated accessibility assertions for shared controls when changing core workflows.

## Testing

### Smart Contracts

```bash
cd contracts
cargo test                    # All contracts
cargo test -p bond-issuer     # Single contract
cargo test -- --nocapture     # With output
```

### API

```bash
cd api
npm run test             # Unit tests
npm run test:e2e         # Integration tests (requires testnet)
npm run test:cov         # Coverage report
```

### Frontend

```bash
cd frontend
ng test                  # Unit tests
ng e2e                   # E2E tests
```

### Full Suite

```bash
cd contracts && cargo test && cd ..
cd api && npm run test && cd ..
cd frontend && ng test --watch=false --browsers=ChromeHeadless && cd ..
cd oracle && npm test && cd ..
```

### Docker Compose (Full Stack)

```bash
# Bootstrap infrastructure and API
./scripts/bootstrap.sh

# Or manually:
docker compose up -d
```

## Mutation Testing

Mutation testing introduces controlled faults (mutants) into the codebase to verify that the test suite can detect them. This provides higher confidence that tests actually validate the critical financial and authorization paths.

### Running Mutation Tests (API)

```bash
cd api
npm run mutate     # Run stryker mutation testing
npm run test:mutate # Run with threshold check (fails if score < 50%)
```

The mutation testing configuration is in `api/stryker-config.json`. Critical modules monitored:
- Financial math: `api/src/bonds/`, `api/src/oracle/`
- Authorization: `api/src/auth/`, `api/src/portfolio/`

### Mutation Testing (Rust Contracts)

Mutation testing for Soroban contracts can be run using `cargo-mut` or similar tools:

```bash
cd contracts
cargo install cargo-mut
cargo mut run --package <package-name>
```

### Interpreting Results

- **Mutation score**: Percentage of mutants killed (detected) by the test suite
- **Surviving mutants**: Indicate potential test gaps - triage and link to follow-up issues
- **Threshold**: Initial gate at 50% for critical paths, aiming for 80%+ over time

## Pull Request Process

1. Ensure all CI checks pass (tests, lint, build)
2. Update documentation if adding or changing functionality
3. Add tests for any new code
4. Link related issues in the PR description
5. Request review from the relevant team:
   - `@core-contracts` for Rust/Soroban changes
   - `@api-team` for NestJS changes
   - `@ui-team` for Angular changes

### PR Checklist

- [ ] `cargo test` passes
- [ ] `cargo clippy` is clean
- [ ] `npm run test` passes (API + Frontend)
- [ ] `npm run build` succeeds (API + Frontend)
- [ ] New code is tested
- [ ] New types / endpoints are documented
- [ ] PR description explains the change and motivation

## Issue Reporting

### Bug Reports

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md). Include:
- Clear description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Rust version, Soroban SDK, network)

### Feature Requests

Use the [Feature Request template](.github/ISSUE_TEMPLATE/feature_request.md). Include:
- What problem does this solve?
- What should be built?
- Alternatives considered

## Security Disclosures

**Do not open public GitHub issues for security vulnerabilities.** Instead, email **nwoguvictoriachiamaka@gmail.com** with details. See [SECURITY.md](SECURITY.md) for our disclosure policy and scope.

## Getting Help

- Check existing [issues](https://github.com/prissca/verdant-bond-protocol/issues) and [discussions](https://github.com/prissca/verdant-bond-protocol/discussions)
- Review [docs/](./docs/) for architecture and design details
- Open a [discussion](https://github.com/prissca/verdant-bond-protocol/discussions) for questions

---

Thank you for helping make Verdant Bond Protocol better!
