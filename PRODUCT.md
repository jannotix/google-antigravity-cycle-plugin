# Product Specification: Cycle for Antigravity

## Core Purpose

Cycle for Antigravity provides evidence-gated software delivery governance for Google Antigravity. It enforces multi-role separation of powers, deterministic verification, candidate freezing, incremental code intelligence, and tamper-evident history without introducing external cloud dependencies or replacing native Antigravity workflows.

## Design Principles

1. **Immutable User Intent**: The user's original request is preserved verbatim as the final acceptance baseline. Paraphrased summaries cannot serve as arbitrated truth.
2. **Deterministic Evidence Over Claims**: Direct command exit codes, test outputs, compiler diagnostics, and candidate digests override any textual claims of completion.
3. **Strict Separation of Powers**: The executor cannot approve its own work. Independent functional and security reviewers evaluate candidates in isolated sessions.
4. **Local Sovereignty**: All state, code graphs, ledgers, and keys reside on the local machine. Provider credentials are never stored or transmitted by Cycle.
5. **Zero Data Loss**: Workflow states and project memory survive application restarts and updates. Schema migrations are transactional and backed up.
6. **Adaptive Resource Limits**: Preserves operating system responsiveness by enforcing RAM and disk reserves before scheduling heavy child processes.

## Role Boundary Matrix

| Role | File Modifications | Execution Tools | Context Provided | Output |
| --- | --- | --- | --- | --- |
| **Architect** | Denied | Read-only analysis | Request + Code Graph | Requirement Matrix + Task DAG |
| **Executor** | Authorized Scope Only | Project Tools & Tests | Single Task + Context | Candidate Diff + Direct Evidence |
| **Functional Reviewer** | Denied | Non-destructive checks | Request + Candidate + Evidence | Functional Verdict |
| **Security Reviewer** | Denied | Non-destructive scans | Request + Candidate + Logs | Security Verdict |
| **Arbiter** | Denied | Non-destructive validation | Request + Candidate + Reviews | Structured Approval / Rejection |

## Code Intelligence Engine

- **Grammar Support**: Rust, TypeScript, JavaScript, Python, Go, Java, Kotlin, C#, C, C++, PHP, Ruby, Swift, Dart, SQL, HTML, CSS, Shell, Data (JSON/YAML/TOML).
- **Index Lifecycle**: Content-addressed cache (SHA-256) ensures files are reparsed only when modified.
- **Graph Invariants**: Explicit edge confidence (`extracted` vs. `inferred`) prevents ambiguous graph pollution.
- **Scale Target**: Validated on repositories containing >500,000 files.
