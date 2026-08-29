import { release } from "../admission.js";
import { issueCaptureCapabilities, redeemCaptureCapability } from "../store/capabilities.js";
import { ROLES } from "../config.js";
import { resolveRole } from "../roles.js";
import { advanceGoalOfWorkflow, linkStartedWorkflow } from "../goals.js";
import { captureBlocked, captureDelivery, recall } from "../memory.js";
import { parseSnapshot } from "../evidence/accessibility.js";
import { commitMessage, DeliveryAborted, deliveryOf, promote, recoverDelivery, } from "../evidence/delivery.js";
import { browserEvidence } from "../evidence/browser.js";
import { proofEvidence, proofGateName } from "../evidence/proof-evidence.js";
import { runProof } from "../evidence/proof.js";
import { loadEvidence, recordEvidence } from "../store/evidence.js";
import { latestCheckpoint, signCheckpoint, verifyCheckpoints } from "../store/checkpoints.js";
import { appendHistory, lastEvent, readHistory, verifyHistory } from "../store/history.js";
import { goalOfWorkflow } from "../store/goals.js";
import { newId } from "../store/ids.js";
import { activeWorkflowForRequest, candidateManifest, createWorkflow, frozenFiles, lastRefusal, latestWorkflow, loadPlan, loadRequest, loadReviews, loadTasks, loadWorkflow, recordArbitration, recordCandidate, requestDigestOf, saveWorkflow, savePlan, setTaskState, submitReview, } from "../store/workflows.js";
import { apply, isTerminal, TransitionError } from "./machine.js";
import { parsePlan } from "./plan.js";
import { route } from "./routing.js";
import { insideAny } from "./scopes.js";
import { parseVerdict } from "./verdicts.js";
export class WorkflowError extends Error {
    constructor(message) {
        super(message);
        this.name = "WorkflowError";
    }
}
function roleModels(configuration) {
    const roles = {};
    for (const role of ROLES) {
        const resolved = resolveRole(configuration, role);
        roles[WORKFLOW_ROLE_NAME[role] ?? role] = {
            effort: resolved.effort,
            model: resolved.model,
            subagentModel: resolved.subagentModel,
        };
    }
    return roles;
}
const WORKFLOW_ROLE_NAME = {
    functional_reviewer: "functional-reviewer",
    security_reviewer: "security-reviewer",
};
export function startWorkflow(context, request, affectedPaths, preference, now = Date.now()) {
    const text = request.trim();
    if (!text)
        throw new WorkflowError("a workflow needs the user's exact request");
    if (/^request\s*=/iu.test(text)) {
        throw new WorkflowError("that request is an argument list, not a request: it begins with `request=`. Pass the user's " +
            "sentence itself as `request`. The arbiter judges the delivered work against this text, so " +
            "a serialisation here would be judged literally.");
    }
    const existing = activeWorkflowForRequest(context.database, context.projectId, requestDigestOf(text));
    if (existing !== undefined) {
        const decision = route(text, affectedPaths, preference);
        return {
            critical: decision.critical,
            goalId: goalOfWorkflow(context.database, existing.id) ?? null,
            mode: existing.mode ?? decision.mode,
            rationale: decision.rationale,
            requestDigest: requestDigestOf(text),
            resumed: true,
            roles: roleModels(context.configuration),
            state: existing.state,
            workflowId: existing.id,
        };
    }
    const { id, requestDigest } = createWorkflow(context.database, context.projectId, text, context.maxRepairCycles, now);
    const decision = route(text, affectedPaths, preference);
    let workflow = load(context, id);
    workflow = transition(context, workflow, { type: "complete_intake" }, now);
    workflow = transition(context, workflow, { mode: decision.mode, type: "route" }, now);
    const goalId = linkStartedWorkflow(context, id, text, now);
    record(context, id, "workflow.started", {
        mode: decision.mode,
        rationale: decision.rationale,
        request_digest: requestDigest,
        ...(goalId === null ? {} : { goal: goalId }),
    });
    return {
        critical: decision.critical,
        goalId,
        mode: decision.mode,
        rationale: decision.rationale,
        requestDigest,
        resumed: false,
        roles: roleModels(context.configuration),
        state: workflow.state,
        workflowId: id,
    };
}
function recordSummary(context, workflow) {
    const database = context.database;
    const counted = (table, column) => {
        const row = database.get(`select count(*) as total from ${table} where ${column} = ?`, workflow.id);
        return Number(row?.["total"] ?? 0);
    };
    const tasks = loadTasks(database, workflow.id);
    const done = tasks.filter((task) => task.state === "completed").length;
    const delivered = counted("deliveries", "workflow_id") > 0;
    return [
        `route ${workflow.mode ?? "unrouted"}`,
        `state ${workflow.state}`,
        `tasks ${done}/${tasks.length}`,
        `reviews ${counted("reviews", "workflow_id")}`,
        `arbitrations ${counted("arbitrations", "workflow_id")}`,
        `repair ${workflow.repairCycles}/${workflow.maxRepairCycles}`,
        delivered ? "delivered" : "not delivered",
        ...(context.configuration.delivered === 0
            ? [
                context.configuration.blank > 0
                    ? `no plugin option reached this process with a value (${context.configuration.blank} arrived empty)`
                    : "no plugin option reached this process",
            ]
            : []),
    ].join(" · ");
}
export function workflowStatus(context, workflowId) {
    const workflow = workflowId === undefined
        ? latestWorkflow(context.database, context.projectId)
        : loadWorkflow(context.database, workflowId);
    if (workflow === undefined)
        return { found: false };
    const request = loadRequest(context.database, workflow.id);
    return {
        found: true,
        lastRefusal: lastRefusal(context.database, workflow.id),
        mode: workflow.mode,
        originalRequest: request?.originalText ?? null,
        pausedBecause: pausedBecause(context, workflow),
        repair: { max: workflow.maxRepairCycles, used: workflow.repairCycles },
        requestDigest: request?.digest ?? null,
        summary: recordSummary(context, workflow),
        roles: roleModels(context.configuration),
        state: workflow.state,
        tasks: loadTasks(context.database, workflow.id).map((task) => ({
            key: task.key,
            state: task.state,
            title: task.title,
            writeScopes: task.writeScopes,
        })),
        terminal: isTerminal(workflow.state),
        workflowId: workflow.id,
    };
}
export function submitPlan(context, workflowId, raw, now = Date.now()) {
    const workflow = load(context, workflowId);
    if (workflow.state !== "architecture") {
        throw new WorkflowError(`a plan is only accepted in architecture, not ${workflow.state}`);
    }
    const plan = parsePlan(raw);
    savePlan(context.database, workflowId, plan, now);
    const next = transition(context, workflow, { type: "architecture_accepted" }, now);
    record(context, workflowId, "architecture.accepted", {
        requirements: String(plan.requirements.length),
        tasks: String(plan.tasks.length),
    });
    return {
        requirements: plan.requirements.map((entry) => entry.id),
        state: next.state,
        tasks: plan.tasks.map((task) => ({ key: task.key, writeScopes: task.writeScopes })),
    };
}
export function reportTask(context, workflowId, key, status, summary, changedPaths = [], now = Date.now()) {
    const workflow = load(context, workflowId);
    if (status === "completed") {
        if (changedPaths === null) {
            record(context, workflowId, "execution.change_set_unreadable", { task: key });
            return {
                reason: "the change set could not be read, so this task's writes cannot be reconciled against " +
                    "the scopes the plan authorized. Nothing has been recorded as completed. Report the " +
                    "task again.",
                retry: true,
                state: workflow.state,
            };
        }
        const violations = outOfScope(context, workflowId, key, changedPaths);
        if (violations.length !== 0) {
            setTaskState(context.database, workflowId, key, "blocked", now);
            record(context, workflowId, "execution.scope_violation", {
                paths: violations.slice(0, 20).join(", "),
                task: key,
            });
            const next = transition(context, workflow, { target: "execution", type: "execution_failed" }, now);
            const pending = pendingOwners(context, workflowId, key, violations);
            return {
                outOfScope: violations,
                reason: pending.length === 0
                    ? `the task changed ${violations.length} path(s) outside every write scope the plan ` +
                        "authorized"
                    : `the task changed path(s) owned by ${pending.join(", ")}, which have not been ` +
                        "reported yet. Report each task as it is completed, before starting the next one. " +
                        "Do not move the changes aside to get past this: the paths are authorized, the " +
                        "order is not.",
                state: next.state,
                unreportedTasks: pending,
            };
        }
    }
    setTaskState(context.database, workflowId, key, status, now);
    record(context, workflowId, `execution.task_${status}`, { summary: summary.slice(0, 2_000), task: key });
    if (status === "plan_defect") {
        const next = transition(context, workflow, { type: "replan" }, now);
        return { state: next.state };
    }
    if (status === "blocked") {
        const next = transition(context, workflow, { target: "execution", type: "execution_failed" }, now);
        return { state: next.state };
    }
    const remaining = loadTasks(context.database, workflowId).filter((task) => task.state !== "completed");
    return { remaining: remaining.map((task) => task.key), state: workflow.state };
}
function pendingOwners(context, workflowId, key, violations) {
    const owners = new Set();
    for (const task of loadTasks(context.database, workflowId)) {
        if (task.key === key || task.state === "completed")
            continue;
        if (violations.some((path) => insideAny(path, task.writeScopes)))
            owners.add(task.key);
    }
    return [...owners].sort();
}
function outOfScope(context, workflowId, key, changedPaths) {
    const tasks = loadTasks(context.database, workflowId);
    if (tasks.length === 0)
        return [];
    const authorized = tasks
        .filter((task) => task.key === key || task.state === "completed")
        .flatMap((task) => task.writeScopes);
    return changedPaths.filter((path) => !insideAny(path, authorized)).sort();
}
export function freezeCandidate(context, workflowId, captured, now = Date.now()) {
    const workflow = load(context, workflowId);
    const candidateId = newId();
    const candidateDigest = recordCandidate(context.database, workflowId, candidateId, captured, now);
    const next = transition(context, workflow, { candidateId, type: "candidate_ready" }, now);
    record(context, workflowId, "candidate.frozen", {
        base_revision: captured.manifest.baseRevision,
        candidate: candidateId,
        diff_digest: captured.manifest.diffDigest,
        digest: candidateDigest,
        files: String(captured.manifest.files.length),
    });
    return {
        baseRevision: captured.manifest.baseRevision,
        candidateDigest,
        candidateId,
        captureCapabilities: issueCaptureCapabilities(context.database, workflowId, candidateId, now),
        files: captured.manifest.files.length,
        state: next.state,
    };
}
export async function deliverCandidate(context, workflowId, root, now = Date.now()) {
    const workflow = load(context, workflowId);
    if (workflow.state !== "delivery") {
        throw new WorkflowError(`delivery is only accepted in delivery, not ${workflow.state}`);
    }
    const candidateId = requireCandidate(workflow);
    let outcome;
    try {
        outcome = await promote(context.database, root, workflowId, candidateId, deliveryMessage(context, workflowId, candidateId), now);
    }
    catch (error) {
        if (!(error instanceof DeliveryAborted))
            throw error;
        record(context, workflowId, "delivery.aborted", { reason: error.message });
        return { aborted: error.message, state: workflow.state };
    }
    const next = transition(context, workflow, { type: "deliver" }, now);
    const learned = captureDelivery(context, {
        candidateId,
        files: outcome.delivered,
        request: loadRequest(context.database, workflowId)?.originalText ?? "",
        revision: outcome.revision,
        workflowId,
    }, now);
    const goal = advanceGoalOfWorkflow(context, workflowId, now);
    record(context, workflowId, "delivery.completed", {
        memories: String(learned.length),
        ...(goal === null ? {} : { goal: goal.goalId, goal_blocked: String(goal.blocked) }),
        files: String(outcome.delivered.length),
        revision: outcome.revision,
        verified_only: String(outcome.verifiedOnly.length),
    });
    signCheckpoint(context.database, context.dataDirectory, now);
    return { ...outcome, goal, state: next.state };
}
export async function reconcile(context, root, workflowId, now = Date.now()) {
    const workflow = workflowId === undefined
        ? latestWorkflow(context.database, context.projectId)
        : loadWorkflow(context.database, workflowId);
    if (workflow === undefined || workflow.projectId !== context.projectId) {
        return { found: false, next: "nothing to resume in this project" };
    }
    let recovered = null;
    if (workflow.state === "delivery") {
        try {
            recovered = await recoverDelivery(context.database, root, workflow.id, deliveryMessage(context, workflow.id, workflow.candidateId ?? ""), now);
            if (recovered !== null) {
                transition(context, workflow, { type: "deliver" }, now);
                record(context, workflow.id, "delivery.recovered", {
                    files: String(recovered.delivered.length),
                    revision: recovered.revision,
                });
                signCheckpoint(context.database, context.dataDirectory, now);
            }
        }
        catch (error) {
            record(context, workflow.id, "delivery.aborted", {
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    const current = loadWorkflow(context.database, workflow.id);
    return {
        chain: verifyHistory(context.database).valid && verifyCheckpoints(context.database).valid,
        delivery: deliveryOf(context.database, workflow.id) ?? null,
        found: true,
        next: NEXT_ACTION[current.state],
        originalRequest: loadRequest(context.database, workflow.id)?.originalText ?? null,
        pausedBecause: pausedBecause(context, current),
        recovered,
        repair: { max: current.maxRepairCycles, used: current.repairCycles },
        state: current.state,
        workflowId: current.id,
    };
}
function rememberIfBlocked(context, workflowId, next, candidateId, now) {
    if (next.state !== "blocked" || candidateId === null)
        return;
    captureBlocked(context, {
        candidateId,
        cycles: next.repairCycles,
        files: frozenFiles(context.database, candidateId).map((file) => file.path),
        request: loadRequest(context.database, workflowId)?.originalText ?? "",
        workflowId,
    }, now);
}
export function recallForRequest(context, request, paths = []) {
    return { memories: recall(context, request, paths) };
}
function deliveryMessage(context, workflowId, candidateId) {
    const request = loadRequest(context.database, workflowId);
    const manifest = candidateManifest(context.database, candidateId);
    if (manifest === undefined) {
        throw new WorkflowError("this candidate has no recorded manifest to commit against");
    }
    return commitMessage(request?.originalText ?? "deliver approved candidate", manifest, workflowId);
}
const NEXT_ACTION = {
    arbitration: "run /cycle:run again to re-dispatch the arbiter against the frozen candidate",
    architecture: "run /cycle:run again: the architect must produce a plan",
    blocked: "the repair budget is exhausted; /cycle:retry extends it",
    cancelled: "nothing: this workflow was cancelled",
    completed: "nothing: this workflow was delivered",
    delivery: "delivery was interrupted and could not be finished; inspect the working tree",
    execution: "run /cycle:run again: the executor must finish its tasks",
    independent_reviews: "run /cycle:run again to re-dispatch the reviewers",
    intake: "run /cycle:run to route this request",
    paused: "/cycle:resume returns it to where it paused",
    quick_execution: "run /cycle:run again: the executor must finish its tasks",
    repair: "/cycle:run continues the repair cycle",
    routing: "run /cycle:run to route this request",
    verification: "run /cycle:run again: the gates must run against the frozen candidate",
};
export function historyState(context, limit = 50, after) {
    return {
        chain: verifyHistory(context.database),
        checkpoint: latestCheckpoint(context.database) ?? null,
        entries: readHistory(context.database, context.projectId, after ?? null, Math.min(limit, 500)).map((entry) => ({
            action: entry.action,
            actor: entry.actor,
            candidate: entry.candidateId,
            hash: entry.hash,
            metadata: entry.metadata,
            recordedAt: entry.recordedAt,
            role: entry.role,
            sequence: entry.sequence,
            workflow: entry.workflowId,
        })),
        signatures: verifyCheckpoints(context.database),
    };
}
export function verifyCandidate(context, workflowId, outcome, now = Date.now()) {
    const workflow = load(context, workflowId);
    if (workflow.state !== "verification") {
        throw new WorkflowError(`verification is only accepted in verification, not ${workflow.state}`);
    }
    record(context, workflowId, "verification.completed", {
        mandatory_passed: String(outcome.mandatoryPassed),
        reason: outcome.reason,
    });
    const next = outcome.mandatoryPassed
        ? transition(context, workflow, { type: "verification_passed" }, now)
        : transition(context, workflow, { target: "execution", type: "verification_failed" }, now);
    rememberIfBlocked(context, workflowId, next, workflow.candidateId, now);
    return { mandatoryPassed: outcome.mandatoryPassed, reason: outcome.reason, state: next.state };
}
export function candidateEvidence(context, workflowId) {
    const workflow = load(context, workflowId);
    const requirements = loadPlan(context.database, workflowId)?.requirements.map((entry) => entry.id) ?? [];
    if (workflow.candidateId === null)
        return { candidate: null, evidence: [], requirements };
    return {
        candidate: workflow.candidateId,
        evidence: loadEvidence(context.database, workflow.candidateId).map((item) => ({
            gate: item.gateName,
            id: item.id,
            mandatory: item.mandatory,
            reason: item.skipReason,
            status: item.status,
        })),
        requirements,
    };
}
export function verificationInputs(context, workflowId) {
    const workflow = load(context, workflowId);
    return {
        candidateId: requireCandidate(workflow),
        taskCommands: loadTasks(context.database, workflowId).flatMap((task) => task.verificationCommands),
    };
}
export function submitReviewVerdict(context, workflowId, role, raw, now = Date.now()) {
    const workflow = load(context, workflowId);
    if (workflow.state !== "independent_reviews") {
        throw new WorkflowError(`a review is only accepted in independent_reviews, not ${workflow.state}`);
    }
    const candidateId = requireCandidate(workflow);
    const verdict = parseVerdict(raw, verdictContext(context, workflowId, role));
    const { reviewsReady } = submitReview(context.database, workflowId, candidateId, role, verdict, now);
    record(context, workflowId, "review.submitted", { decision: verdict.decision, role });
    let next = workflow;
    if (reviewsReady)
        next = transition(context, workflow, { type: "reviews_ready" }, now);
    return { decision: verdict.decision, reviewsReady, state: next.state };
}
export function submitBrowserEvidence(context, workflowId, raw, captureToken = null, now = Date.now()) {
    const workflow = load(context, workflowId);
    if (workflow.state !== "verification" && workflow.state !== "independent_reviews") {
        throw new WorkflowError(`browser evidence is accepted while the candidate is being verified or reviewed, not in ${workflow.state}`);
    }
    const candidateId = requireCandidate(workflow);
    let capturedBy = "executor";
    if (captureToken !== null) {
        const redeemed = redeemCaptureCapability(context.database, candidateId, captureToken, now);
        if (redeemed.role === null) {
            throw new WorkflowError(`this capture capability is ${redeemed.reason === "consumed" ? "already spent" : "not valid for this candidate"}. ` +
                "It is issued to one reviewing role when the candidate is frozen and can be spent once. " +
                "Submit without it to record a self-reported capture, which carries no weight.");
        }
        capturedBy = redeemed.role;
    }
    const snapshot = parseSnapshot(raw);
    const { evidence, findings } = browserEvidence(snapshot, capturedBy, now);
    recordEvidence(context.database, candidateId, evidence, (item) => item.gate.mandatory);
    record(context, workflowId, "browser.captured", {
        capturedBy,
        findings: String(findings.length),
        flow: snapshot.capturedFlow.slice(0, 200),
        url: snapshot.url.slice(0, 500),
    });
    return {
        accessibility: findings,
        capturedBy,
        evidenceIds: evidence.map((item) => item.id),
        state: workflow.state,
    };
}
export async function submitSecurityProof(context, workflowId, root, request, now = Date.now()) {
    const workflow = load(context, workflowId);
    if (workflow.state !== "independent_reviews" && workflow.state !== "arbitration") {
        throw new WorkflowError(`a proof is run while the candidate is under review, not in ${workflow.state}`);
    }
    if (!context.configuration.securityProofs) {
        throw new WorkflowError("executing a proof is off. A proof runs code supplied by the reviewer against a copy of the " +
            "candidate, with this account's privileges and no operating-system sandbox, so it is " +
            "enabled deliberately: set the plugin's security_proofs option to on. Until then, state " +
            "the vulnerability and the reasoning in the review; an undemonstrated critical is " +
            "downgraded, not discarded.");
    }
    const candidateId = requireCandidate(workflow);
    const gateName = proofGateName(request.vulnerabilityClass);
    const rationale = request.rationale.trim().slice(0, 2_000);
    if (!rationale)
        throw new WorkflowError("a proof must say what it is trying to demonstrate");
    const result = await runProof(root, {
        ...(request.command === undefined ? {} : { command: request.command }),
        ...(request.interpreter === undefined ? {} : { interpreter: request.interpreter }),
        ...(request.script === undefined ? {} : { script: request.script }),
    });
    const evidence = proofEvidence(request.vulnerabilityClass, rationale, result, now);
    recordEvidence(context.database, candidateId, [evidence], (item) => item.gate.mandatory);
    record(context, workflowId, `security.proof_${result.demonstrated ? "demonstrated" : "inconclusive"}`, {
        gate: gateName,
        rationale,
    });
    return {
        containment: result.containment,
        demonstrated: result.demonstrated,
        evidenceId: evidence.id,
        exitCode: evidence.exitCode,
        gate: gateName,
        output: evidence.output.slice(0, 8_000),
        status: evidence.status,
    };
}
export function mandatoryGatesPassed(context, workflowId) {
    const row = context.database.get(`select count(*) as total, sum(case when e.status != 'passed' then 1 else 0 end) as failed
       from evidence e join workflows w on w.candidate_id = e.candidate_id
      where w.id = ? and e.mandatory = 1`, workflowId);
    return (row?.total ?? 0) > 0 && (row?.failed ?? 0) === 0;
}
export function arbitrate(context, workflowId, raw, mandatoryPassed, now = Date.now()) {
    const workflow = load(context, workflowId);
    if (workflow.state !== "arbitration") {
        throw new WorkflowError(`arbitration is only accepted in arbitration, not ${workflow.state}`);
    }
    const candidateId = requireCandidate(workflow);
    const verdict = parseVerdict(raw, verdictContext(context, workflowId, "arbiter"));
    if (workflow.mode === "full") {
        const reviews = loadReviews(context.database, candidateId);
        if (reviews.length < 2)
            throw new WorkflowError("arbitration requires both independent reviews");
        if (verdict.decision === "approved" && reviews.some((r) => r.verdict.decision === "rejected")) {
            throw new WorkflowError("arbitration cannot approve while a reviewer rejected the candidate");
        }
    }
    const receiptDigest = recordArbitration(context.database, workflowId, candidateId, verdict, now);
    let next;
    let refusal = null;
    if (verdict.decision === "approved") {
        try {
            next = transition(context, workflow, { mandatoryGatesPassed: mandatoryPassed, type: "approve" }, now);
        }
        catch (error) {
            if (!(error instanceof TransitionError) || error.code !== "gates_not_passed")
                throw error;
            refusal = error.message;
            next = transition(context, workflow, { target: "execution", type: "reject" }, now);
        }
    }
    else {
        next = transition(context, workflow, { target: verdict.repairTarget ?? "execution", type: "reject" }, now);
    }
    record(context, workflowId, `arbitration.${refusal === null ? verdict.decision : "refused"}`, {
        receipt_digest: receiptDigest,
        ...(refusal === null ? {} : { refusal }),
    });
    rememberIfBlocked(context, workflowId, next, candidateId, now);
    return {
        decision: verdict.decision,
        receiptDigest,
        refusal,
        repair: { max: next.maxRepairCycles, used: next.repairCycles },
        state: next.state,
    };
}
export function control(context, workflowId, operation, reason, now = Date.now()) {
    const workflow = load(context, workflowId);
    const command = COMMANDS[operation] ?? { type: operation };
    const next = transition(context, workflow, command, now);
    const classification = reason?.trim().slice(0, MAX_REASON);
    record(context, workflowId, `control.${operation}`, classification ? { reason: classification } : {});
    if (operation === "cancel")
        signCheckpoint(context.database, context.dataDirectory, now);
    return {
        repairTarget: workflow.repairTarget,
        ...(classification ? { reason: classification } : {}),
        state: next.state,
    };
}
const MAX_REASON = 512;
function pausedBecause(context, workflow) {
    if (workflow.state !== "paused")
        return null;
    return lastEvent(context.database, workflow.id, "control.pause")?.metadata["reason"] ?? null;
}
const COMMANDS = {
    cancel: { type: "cancel" },
    pause: { type: "pause" },
    repair: { type: "begin_repair" },
    resume: { type: "resume" },
    retry: { additionalCycles: 1, type: "resume_blocked" },
};
function verdictContext(context, workflowId, role) {
    const workflow = load(context, workflowId);
    const plan = loadPlan(context.database, workflowId);
    const evidence = context.database.all("select e.id from evidence e join workflows w on w.candidate_id = e.candidate_id where w.id = ?", workflowId);
    const proofIds = loadEvidence(context.database, workflow.candidateId ?? "")
        .filter((item) => item.gateName.startsWith("security:proof:") && item.status === "failed")
        .map((item) => item.id);
    return {
        evidenceIds: evidence.map((row) => row.id),
        proofIds,
        requirementIds: plan?.requirements.map((entry) => entry.id) ?? [],
        requiresProof: role === "security_reviewer",
        role,
    };
}
function transition(context, workflow, command, now) {
    const next = { ...workflow, ...apply(workflow, command) };
    saveWorkflow(context.database, next, now);
    if (isTerminal(next.state) || next.state === "blocked" || next.state === "paused") {
        release(context.database, next.id);
    }
    return next;
}
function load(context, workflowId) {
    const workflow = loadWorkflow(context.database, workflowId);
    if (workflow === undefined)
        throw new WorkflowError(`unknown workflow: ${workflowId}`);
    if (workflow.projectId !== context.projectId) {
        throw new WorkflowError("that workflow belongs to another project");
    }
    return workflow;
}
function requireCandidate(workflow) {
    if (workflow.candidateId === null)
        throw new WorkflowError("this workflow has no frozen candidate");
    return workflow.candidateId;
}
const CHECKPOINT_EVERY = 100;
function record(context, workflowId, action, metadata) {
    const entry = appendHistory(context.database, { action, actor: "cycle", metadata, projectId: context.projectId, workflowId }, Date.now());
    if (entry.sequence % CHECKPOINT_EVERY === 0) {
        signCheckpoint(context.database, context.dataDirectory);
    }
}
const EXPORT_LIMIT = 5_000;
export function exportState(context, kind, workflowId) {
    if (kind === "history") {
        const entries = readHistory(context.database, context.projectId, null, EXPORT_LIMIT);
        const total = context.database.get("select count(*) as entries from history where project_id = ?", context.projectId);
        return {
            chain: verifyHistory(context.database),
            entries,
            kind,
            truncated: Number(total?.entries ?? 0) > entries.length,
        };
    }
    if (kind === "evidence") {
        const workflow = resolveForExport(context, workflowId);
        return {
            candidateId: workflow.candidateId,
            evidence: loadEvidence(context.database, workflow.candidateId ?? ""),
            kind,
            workflowId: workflow.id,
        };
    }
    const workflow = resolveForExport(context, workflowId);
    return {
        kind,
        plan: loadPlan(context.database, workflow.id),
        request: loadRequest(context.database, workflow.id),
        reviews: loadReviews(context.database, workflow.candidateId ?? ""),
        tasks: loadTasks(context.database, workflow.id),
        workflow: {
            candidateId: workflow.candidateId,
            mode: workflow.mode,
            repair: { max: workflow.maxRepairCycles, used: workflow.repairCycles },
            state: workflow.state,
            workflowId: workflow.id,
        },
    };
}
function resolveForExport(context, workflowId) {
    const workflow = workflowId === undefined
        ? latestWorkflow(context.database, context.projectId)
        : loadWorkflow(context.database, workflowId);
    if (workflow === undefined || workflow.projectId !== context.projectId) {
        throw new WorkflowError("there is no such workflow in this project");
    }
    return workflow;
}
