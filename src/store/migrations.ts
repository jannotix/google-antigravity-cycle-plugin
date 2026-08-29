export interface Migration {
  readonly name: string
  readonly sql: string
  readonly version: number
}

// Forward-only and additive. A released migration is never edited; a correction is a new one.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "delivery",
    sql: `
create table workflows (
  id                text primary key,
  project_id        text not null,
  state             text not null,
  mode              text,
  candidate_id      text,
  repair_target     text,
  repair_cycles     integer not null default 0,
  max_repair_cycles integer not null,
  paused_from       text,
  blocked_from      text,
  created_at        integer not null,
  updated_at        integer not null
) strict;

create index workflows_by_project on workflows (project_id, updated_at desc);

-- The original request is the acceptance source for the arbiter. Clarifications are appended as
-- sequenced amendments; the original text is never rewritten.
create table requests (
  workflow_id        text primary key references workflows (id) on delete cascade,
  original_text      text not null,
  digest             text not null,
  attachment_digests text not null default '[]',
  amendments         text not null default '[]',
  created_at         integer not null
) strict;

create trigger requests_original_is_immutable
before update of original_text, digest on requests
begin
  select raise(abort, 'the original request is immutable');
end;

create table tasks (
  id                    text primary key,
  workflow_id           text not null references workflows (id) on delete cascade,
  task_key              text not null,
  title                 text not null,
  objective             text not null,
  state                 text not null,
  position              integer not null,
  write_scopes          text not null default '[]',
  dependencies          text not null default '[]',
  requirement_ids       text not null default '[]',
  acceptance_criteria   text not null default '[]',
  verification_commands text not null default '[]',
  revision              text,
  created_at            integer not null,
  updated_at            integer not null,
  unique (workflow_id, task_key)
) strict;

create table candidates (
  id               text primary key,
  workflow_id      text not null references workflows (id) on delete cascade,
  base_revision    text,
  manifest         text not null,
  diff_digest      text not null,
  candidate_digest text not null,
  frozen_at        integer not null
) strict;

create table candidate_files (
  candidate_id text not null references candidates (id) on delete cascade,
  path         text not null,
  kind         text not null,
  digest       text,
  payload      blob,
  primary key (candidate_id, path)
) strict;

create table evidence (
  id            text primary key,
  candidate_id  text not null references candidates (id) on delete cascade,
  gate_name     text not null,
  kind          text not null,
  status        text not null,
  mandatory     integer not null,
  invocation    text not null,
  exit_code     integer,
  skip_reason   text,
  started_at    integer not null,
  finished_at   integer not null,
  output        text not null default '',
  output_digest text not null,
  unique (candidate_id, gate_name)
) strict;

create table reviews (
  id             text primary key,
  workflow_id    text not null references workflows (id) on delete cascade,
  candidate_id   text not null references candidates (id) on delete cascade,
  role           text not null,
  verdict        text not null,
  verdict_digest text not null,
  submitted_at   integer not null,
  unique (candidate_id, role)
) strict;

create table arbitrations (
  id             text primary key,
  workflow_id    text not null references workflows (id) on delete cascade,
  candidate_id   text not null references candidates (id) on delete cascade,
  decision       text not null,
  verdict        text not null,
  receipt        text not null,
  receipt_digest text not null,
  finalized_at   integer not null,
  unique (candidate_id)
) strict;

create table leases (
  workflow_id text primary key references workflows (id) on delete cascade,
  project_id  text not null,
  acquired_at integer not null,
  expires_at  integer not null
) strict;

create index leases_by_expiry on leases (expires_at);
`,
  },
  {
    version: 2,
    name: "knowledge",
    sql: `
-- Append-only. Sequence is contiguous from zero and each entry commits to its predecessor.
create table history (
  sequence      integer primary key,
  project_id    text not null,
  actor         text not null,
  role          text,
  session_id    text,
  workflow_id   text,
  candidate_id  text,
  action        text not null,
  event         text not null,
  files         text not null default '[]',
  evidence_ids  text not null default '[]',
  recorded_at   integer not null,
  previous_hash text,
  hash          text not null
) strict;

create index history_by_project on history (project_id, sequence);

create trigger history_is_append_only_update
before update on history
begin
  select raise(abort, 'project history is append-only');
end;

create trigger history_is_append_only_delete
before delete on history
begin
  select raise(abort, 'project history is append-only');
end;

create table checkpoints (
  sequence   integer primary key references history (sequence),
  hash       text not null,
  signature  text not null,
  public_key text not null,
  created_at integer not null
) strict;

create table memory (
  id            text primary key,
  project_id    text not null,
  kind          text not null,
  confidence    text not null,
  state         text not null,
  title         text not null,
  summary       text not null,
  detail        text not null,
  scope         text not null default '[]',
  superseded_by text references memory (id),
  created_at    integer not null,
  updated_at    integer not null
) strict;

create index memory_by_project on memory (project_id, state, updated_at desc);

create virtual table memory_fts using fts5 (
  title, summary, detail,
  content = 'memory',
  content_rowid = 'rowid'
);

create trigger memory_fts_after_insert after insert on memory
begin
  insert into memory_fts (rowid, title, summary, detail)
  values (new.rowid, new.title, new.summary, new.detail);
end;

create trigger memory_fts_after_delete after delete on memory
begin
  insert into memory_fts (memory_fts, rowid, title, summary, detail)
  values ('delete', old.rowid, old.title, old.summary, old.detail);
end;

create trigger memory_fts_after_update after update on memory
begin
  insert into memory_fts (memory_fts, rowid, title, summary, detail)
  values ('delete', old.rowid, old.title, old.summary, old.detail);
  insert into memory_fts (rowid, title, summary, detail)
  values (new.rowid, new.title, new.summary, new.detail);
end;

-- One provenance shape, shared by memory, the code graph and history references.
create table memory_provenance (
  id             text primary key,
  memory_id      text not null references memory (id) on delete cascade,
  candidate_id   text,
  evidence_id    text,
  revision       text,
  session_id     text,
  role           text,
  event_sequence integer
) strict;

create index memory_provenance_by_memory on memory_provenance (memory_id);

create table graph_nodes (
  id         text primary key,
  project_id text not null,
  kind       text not null,
  name       text not null,
  path       text not null,
  start_line integer not null,
  end_line   integer not null,
  language   text not null,
  digest     text not null
) strict;

create index graph_nodes_by_path on graph_nodes (project_id, path);
create index graph_nodes_by_name on graph_nodes (project_id, name);

create table graph_edges (
  id         text primary key,
  project_id text not null,
  from_id    text not null references graph_nodes (id) on delete cascade,
  to_id      text not null references graph_nodes (id) on delete cascade,
  kind       text not null,
  confidence text not null,
  provenance text not null
) strict;

create index graph_edges_by_source on graph_edges (from_id);
create index graph_edges_by_target on graph_edges (to_id);

create table index_state (
  project_id text not null,
  path       text not null,
  digest     text not null,
  language   text,
  indexed_at integer not null,
  primary key (project_id, path)
) strict;

create table goals (
  id                text primary key,
  project_id        text not null,
  objective         text not null,
  objective_digest  text not null,
  state             text not null,
  constraints       text not null default '[]',
  non_goals         text not null default '[]',
  success_criteria  text not null default '[]',
  amendments        text not null default '[]',
  continuations     integer not null default 0,
  max_continuations integer not null,
  paused_from       text,
  blocked_from      text,
  focused_session   text,
  created_at        integer not null,
  updated_at        integer not null
) strict;

create trigger goals_objective_is_immutable
before update of objective, objective_digest on goals
begin
  select raise(abort, 'the goal objective is immutable');
end;

create table goal_plans (
  goal_id           text not null references goals (id) on delete cascade,
  version           integer not null,
  content           text not null,
  source_session_id text,
  created_at        integer not null,
  primary key (goal_id, version)
) strict;

create table goal_milestones (
  goal_id     text not null references goals (id) on delete cascade,
  name        text not null,
  workflow_id text references workflows (id),
  state       text not null,
  created_at  integer not null,
  primary key (goal_id, name)
) strict;
`,
  },
  {
    version: 3,
    name: "index-references",
    sql: `
-- Extracted imports and calls, kept per file so edges can be re-resolved when a neighbouring file
-- changes without reparsing anything that did not.
alter table index_state add column refs_json text not null default '[]';
`,
  },
  {
    version: 4,
    name: "workflow-plan",
    sql: `
-- The validated architecture, kept with the workflow it governs rather than with the request it
-- came from: the request is the user's, the plan is the architect's interpretation of it.
alter table workflows add column plan_json text not null default '';
`,
  },
  {
    version: 5,
    name: "delivery-journal",
    sql: `
-- Promotion is several steps against the filesystem, so the intent is written down before the first
-- one and cleared after the last. A control plane killed in between finds the journal and finishes
-- or abandons the delivery rather than leaving the repository half written.
create table deliveries (
  candidate_id text primary key references candidates (id) on delete cascade,
  workflow_id  text not null references workflows (id) on delete cascade,
  state        text not null,
  manifest     text not null,
  written      text not null default '[]',
  reason       text,
  started_at   integer not null,
  updated_at   integer not null
) strict;

create index deliveries_by_workflow on deliveries (workflow_id);
`,
  },
  {
    version: 6,
    name: "index-stat-cache",
    sql: `
-- Reading a file to notice it did not change costs an order of magnitude more than asking the
-- filesystem when it was last written. Size and mtime are the cheap question; the digest stays the
-- authoritative answer whenever they differ.
alter table index_state add column size integer not null default -1;
alter table index_state add column modified_at integer not null default -1;
`,
  },
  {
    version: 7,
    name: "capture-capability",
    sql: `
-- The interface layer's proof is a flow somebody drove. Over stdio the plane has no notion of who
-- is calling: it reads a line. A submission that names its own role is therefore a claim, and the
-- party the gate exists to check can make it. The plane instead mints one secret per reviewing role
-- when reviews open, keeps only its digest, and hands each to that role alone. The role then comes
-- from the record rather than from the caller, and the secret is spent on first use.
create table capture_capabilities (
  digest       text primary key,
  workflow_id  text not null references workflows (id) on delete cascade,
  candidate_id text not null references candidates (id) on delete cascade,
  role         text not null,
  issued_at    integer not null,
  consumed_at  integer,
  unique (candidate_id, role)
) strict;

create index capture_capabilities_by_candidate on capture_capabilities (candidate_id);
`,
  },
]

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
)
