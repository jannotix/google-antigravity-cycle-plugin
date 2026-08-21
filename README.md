# Cycle for Antigravity

Evidence-gated software delivery extension for Google Antigravity Desktop and CLI.

Cycle replaces the single-agent self-approval pattern with five isolated roles: an architect, an executor, two independent reviewers, and a final arbiter that evaluates the candidate against your immutable original request. A candidate is delivered only when real evidence satisfies every gate and the arbiter approves.

## The Problem

A coding agent operating in a single context inherits its own blind spots and declares its work complete without deterministic proof. Common failure modes include:
- An endpoint with no user interface reaching it.
- A database migration created but never executed against a real database instance.
- Tests passing against mocks while real integration paths remain broken.
- Security controls implemented on primary paths but bypassed on secondary paths.
- Code completing syntactically while failing enterprise packaging or runtime constraints.

Cycle eliminates these blind spots by enforcing separation of powers and requiring verifiable evidence before code promotion.

## Architecture

```
User Request ──▶  Architect       Requirement matrix, acyclic task DAG, write scopes
                  Executor        Bounded tasks executed in isolated Git worktrees
                  Verification    Deterministic checks (types, tests, linters, security scans)
                  Reviewers       Functional & security reviews in isolated sessions
                  Arbiter         Judges frozen candidate digest against immutable request
                  Delivery        Atomic promotion of approved candidate bytes
```

### 1. Separation of Powers
- **Architect**: Generates requirement matrix and acyclic task DAG with explicit write scopes. Read-only; cannot modify files or approve candidates.
- **Executor**: Implements authorized tasks within designated write scopes. Cannot alter acceptance criteria or self-approve.
- **Functional Reviewer**: Independently verifies user-facing completeness, edge cases, and regression risks.
- **Security & Architecture Reviewer**: Evaluates trust boundaries, credential handling, injection vulnerabilities, dependency supply chains, and architectural consistency.
- **Arbiter**: Evaluates raw deterministic evidence, reviewer findings, candidate diffs, and the immutable original request to issue structured approval or rejection.

### 2. Candidate Freeze & Delivery
- Changes are frozen into a deterministic manifest with SHA-256 digests before gates execute.
- Verification failures or arbiter rejections route back to targeted repair (up to 5 cycles by default).
- Delivery performs transactional promotion against the base Git revision, ensuring no unapproved bytes enter the target workspace.

### 3. Native Code Intelligence
- Incremental Tree-sitter semantic graph for 16+ languages (Rust, TypeScript/JS, Python, Go, Java/Kotlin, C#, C/C++, PHP, Ruby, Swift, Dart, SQL, HTML/CSS, Shell, Data formats).
- Symbol, import, call, and inheritance relationship tracking with precision-first confidence levels.
- Benchmarked and certified for repositories exceeding 500,000 files.

### 4. Tamper-Evident Project History & Memory
- Append-only cryptographic ledger with SHA-256 hash chains and locally signed Ed25519 checkpoints.
- Automatic secret redaction prevents credential leakage into persistent stores.
- Project memory stores verified decisions, validated fixes, and constraints with SQLite FTS5 progressive retrieval.

### 5. Adaptive Resource Governance
- Continuous monitoring of CPU, RAM, disk space, and process trees.
- Enforces a minimum 15% physical RAM reserve before admitting resource-intensive tasks (compilation, test runners, headless browser instances).

## Model Independence

Cycle is completely model-agnostic. Each role can be configured with distinct providers and models in user or project settings (`~/.gemini/config/cycle/config.json` or `.agents/cycle.json`):

```json
{
  "models": {
    "architect": "gemini-2.5-pro",
    "executor": "gemini-2.5-pro",
    "functional_reviewer": "gemini-2.5-flash",
    "security_reviewer": "gemini-2.5-pro",
    "arbiter": "gemini-2.5-pro"
  }
}
```

Use `/cycle:models` to inspect current role assignments and verify verdict independence.

## Commands

All operations execute automatically when preconditions are met. Commands are available for inspection, control, and recovery:

| Command | Description |
| --- | --- |
| `/cycle:doctor` | Verifies runtime prerequisites, IPC health, SQLite database integrity, and key store |
| `/cycle:run [auto\|quick\|full]` | Arms the workflow with an optional routing override |
| `/cycle:status` | Displays phase, active tasks, resource metrics, and blockers |
| `/cycle:tasks` | Displays task DAG, ownership, write scopes, and status |
| `/cycle:evidence` | Lists verification receipts and gate evaluations for the frozen candidate |
| `/cycle:models` | Inspects and configures per-role provider and model assignments |
| `/cycle:permissions` | Inspects role boundaries and active permission presets |
| `/cycle:limits` | Displays resource admission thresholds and repair budget settings |
| `/cycle:memory` | Searches and inspects verified project knowledge and architectural decisions |
| `/cycle:history` | Queries audit ledger events and verifies hash chain integrity |
| `/cycle:pause` / `/cycle:resume` | Safely pauses or resumes active workflow execution |
| `/cycle:retry` | Extends repair budget or re-executes transiently failed tasks |
| `/cycle:cancel` | Safely terminates active execution and cleans up temporary worktrees |
| `/cycle:help` | Complete command reference and guidance |

## Installation

Add the plugin to your Antigravity configuration or workspace `.agents/plugins.json`:

```json
{
  "plugins": ["antigravity-cycle"]
}
```

Then run:
```text
/cycle:doctor
```

## Requirements

- Google Antigravity Desktop or CLI (Windows x64 / Linux x64)
- Git
- Project build and test toolchains

## License

FSL-1.1-MIT. Copyright 2026 Gianluca Iannotta. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Cycle for Antigravity is an independent integration. It is not affiliated with, sponsored by, or endorsed by Google.
