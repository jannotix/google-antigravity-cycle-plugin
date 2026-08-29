import { DIGEST_DOMAIN, digest, newId } from "./ids.js";
export function createWorkflow(database, projectId, originalText, maxRepairCycles, now) {
    const id = newId();
    const requestDigest = digest(DIGEST_DOMAIN.request, { attachments: [], text: originalText });
    database.transaction(() => {
        database.run(`insert into workflows (id, project_id, state, max_repair_cycles, created_at, updated_at)
       values (?, ?, 'intake', ?, ?, ?)`, id, projectId, maxRepairCycles, now, now);
        database.run("insert into requests (workflow_id, original_text, digest, created_at) values (?, ?, ?, ?)", id, originalText, requestDigest, now);
    });
    return { id, requestDigest };
}
export function requestDigestOf(originalText) {
    return digest(DIGEST_DOMAIN.request, { attachments: [], text: originalText });
}
export function activeWorkflowForRequest(database, projectId, requestDigest) {
    const row = database.get(`select workflows.* from workflows
       join requests on requests.workflow_id = workflows.id
      where workflows.project_id = ?
        and requests.digest = ?
        and workflows.state not in ('cancelled', 'completed')
      order by workflows.created_at desc
      limit 1`, projectId, requestDigest);
    return row === undefined ? undefined : toWorkflow(row);
}
export function loadWorkflow(database, id) {
    const row = database.get("select * from workflows where id = ?", id);
    return row === undefined ? undefined : toWorkflow(row);
}
export function latestWorkflow(database, projectId) {
    const row = database.get("select * from workflows where project_id = ? order by updated_at desc limit 1", projectId);
    return row === undefined ? undefined : toWorkflow(row);
}
export function saveWorkflow(database, workflow, now) {
    database.run(`update workflows set state = ?, mode = ?, candidate_id = ?, repair_target = ?,
       repair_cycles = ?, max_repair_cycles = ?, paused_from = ?, blocked_from = ?, updated_at = ?
     where id = ?`, workflow.state, workflow.mode, workflow.candidateId, workflow.repairTarget, workflow.repairCycles, workflow.maxRepairCycles, workflow.pausedFrom, workflow.blockedFrom, now, workflow.id);
}
export function loadRequest(database, workflowId) {
    const row = database.get("select * from requests where workflow_id = ?", workflowId);
    if (row === undefined)
        return undefined;
    return {
        amendments: JSON.parse(String(row["amendments"])),
        digest: String(row["digest"]),
        originalText: String(row["original_text"]),
    };
}
export function amendRequest(database, workflowId, text, now) {
    const current = loadRequest(database, workflowId);
    if (current === undefined)
        throw new Error("no request for this workflow");
    const amendments = [
        ...current.amendments,
        { receivedAt: now, sequence: current.amendments.length + 1, text },
    ];
    database.run("update requests set amendments = ? where workflow_id = ?", JSON.stringify(amendments), workflowId);
}
export function savePlan(database, workflowId, plan, now) {
    database.transaction(() => {
        database.run("delete from tasks where workflow_id = ?", workflowId);
        plan.tasks.forEach((task, position) => {
            database.run(`insert into tasks (
           id, workflow_id, task_key, title, objective, state, position,
           write_scopes, dependencies, requirement_ids, acceptance_criteria,
           verification_commands, created_at, updated_at
         ) values (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), workflowId, task.key, task.title, task.objective, position, JSON.stringify(task.writeScopes), JSON.stringify(task.dependencies), JSON.stringify(task.requirementIds), JSON.stringify(task.acceptanceCriteria), JSON.stringify(task.verificationCommands), now, now);
        });
        database.run("update workflows set plan_json = ?, updated_at = ? where id = ?", JSON.stringify(plan), now, workflowId);
    });
}
export function loadPlan(database, workflowId) {
    const row = database.get("select plan_json from workflows where id = ?", workflowId);
    const raw = String(row?.["plan_json"] ?? "");
    if (!raw)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
export function loadTasks(database, workflowId) {
    return database
        .all("select * from tasks where workflow_id = ? order by position", workflowId)
        .map((row) => ({
        id: String(row["id"]),
        key: String(row["task_key"]),
        objective: String(row["objective"]),
        position: Number(row["position"]),
        state: String(row["state"]),
        title: String(row["title"]),
        verificationCommands: JSON.parse(String(row["verification_commands"])),
        writeScopes: JSON.parse(String(row["write_scopes"])),
    }));
}
export function setTaskState(database, workflowId, key, state, now) {
    database.run("update tasks set state = ?, updated_at = ? where workflow_id = ? and task_key = ?", state, now, workflowId, key);
}
export function recordCandidate(database, workflowId, candidateId, captured, now) {
    const { manifest, payloads } = captured;
    database.transaction(() => {
        database.run(`insert into candidates (id, workflow_id, base_revision, manifest, diff_digest, candidate_digest, frozen_at)
       values (?, ?, ?, ?, ?, ?, ?)`, candidateId, workflowId, manifest.baseRevision, JSON.stringify(manifest), manifest.diffDigest, manifest.candidateDigest, now);
        for (const file of manifest.files) {
            database.run("insert into candidate_files (candidate_id, path, kind, digest, payload) values (?, ?, ?, ?, ?)", candidateId, file.path, file.kind, file.digest, payloads.get(file.path) ?? null);
        }
    });
    return manifest.candidateDigest;
}
export function candidateManifest(database, candidateId) {
    const row = database.get("select manifest from candidates where id = ?", candidateId);
    if (row === undefined)
        return undefined;
    try {
        return JSON.parse(String(row["manifest"]));
    }
    catch {
        return undefined;
    }
}
export function frozenFiles(database, candidateId) {
    return database
        .all("select path, kind, digest from candidate_files where candidate_id = ? order by path", candidateId)
        .map((row) => ({
        digest: row["digest"] ?? null,
        kind: String(row["kind"]),
        path: String(row["path"]),
    }));
}
export function submitReview(database, workflowId, candidateId, role, verdict, now) {
    database.run(`insert into reviews (id, workflow_id, candidate_id, role, verdict, verdict_digest, submitted_at)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict (candidate_id, role) do update set
       verdict = excluded.verdict, verdict_digest = excluded.verdict_digest,
       submitted_at = excluded.submitted_at`, newId(), workflowId, candidateId, role, JSON.stringify(verdict), digest(DIGEST_DOMAIN.verdict, verdict), now);
    const count = database.get("select count(*) as total from reviews where candidate_id = ?", candidateId);
    return { reviewsReady: (count?.total ?? 0) >= 2 };
}
export function loadReviews(database, candidateId) {
    return database
        .all("select role, verdict from reviews where candidate_id = ? order by role", candidateId)
        .map((row) => ({
        role: String(row["role"]),
        verdict: JSON.parse(String(row["verdict"])),
    }));
}
export function lastRefusal(database, workflowId) {
    const arbitration = database.get(`select candidate_id, verdict from arbitrations
      where workflow_id = ? and decision = 'rejected'
      order by finalized_at desc limit 1`, workflowId);
    if (arbitration === undefined)
        return [];
    const candidateId = String(arbitration["candidate_id"]);
    const refusals = [];
    for (const review of loadReviews(database, candidateId)) {
        if (review.verdict.decision !== "rejected")
            continue;
        refusals.push({ findings: review.verdict.findings ?? [], from: review.role });
    }
    const verdict = JSON.parse(String(arbitration["verdict"]));
    refusals.push({ findings: verdict.findings ?? [], from: "arbiter" });
    return refusals.filter((refusal) => refusal.findings.length > 0);
}
export function recordArbitration(database, workflowId, candidateId, verdict, now) {
    const receiptDigest = digest(DIGEST_DOMAIN.verdict, { candidateId, verdict, workflowId });
    database.run(`insert into arbitrations (
       id, workflow_id, candidate_id, decision, verdict, receipt, receipt_digest, finalized_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (candidate_id) do update set
       decision = excluded.decision, verdict = excluded.verdict,
       receipt = excluded.receipt, receipt_digest = excluded.receipt_digest,
       finalized_at = excluded.finalized_at`, newId(), workflowId, candidateId, verdict.decision, JSON.stringify(verdict), JSON.stringify({ candidateId, decision: verdict.decision, workflowId }), receiptDigest, now);
    return receiptDigest;
}
function toWorkflow(row) {
    return {
        blockedFrom: row["blocked_from"] ?? null,
        candidateId: row["candidate_id"] ?? null,
        createdAt: Number(row["created_at"]),
        id: String(row["id"]),
        maxRepairCycles: Number(row["max_repair_cycles"]),
        mode: row["mode"] ?? null,
        pausedFrom: row["paused_from"] ?? null,
        projectId: String(row["project_id"]),
        repairCycles: Number(row["repair_cycles"]),
        repairTarget: row["repair_target"] ?? null,
        state: String(row["state"]),
        updatedAt: Number(row["updated_at"]),
    };
}
