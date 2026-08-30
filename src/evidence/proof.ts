import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, copyFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

import { redactSecrets } from "../secrets.ts"
import { parseCommand, UnsafeCommand, type SafeCommand } from "../workflow/commands.ts"
import { runCommand, type RunOutcome } from "./runner.ts"
import { gitArgs } from "../git.ts"

const execFileAsync = promisify(execFile)

/** Lower than the 600s gate default: a proof that needs ten minutes is not a proof. */
export const PROOF_TIMEOUT_SECONDS = 60

const MAX_COPIED_FILES = 5_000
const MAX_COPIED_BYTES = 64 * 1_024 * 1_024
const GIT_TIMEOUT_MS = 30_000

export function proofWorkspacePrefix(root: string): string {
  const identity = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12)
  return `cycle-proof-${identity}-`
}

/**
 * A proof runs against a throwaway copy and must not reach the network, install anything, or
 * publish anything. These arguments are refused on top of the ordinary gate rules.
 */
const REFUSED_ARGUMENTS = new Set([
  "add",
  "curl",
  "download",
  "fetch",
  "install",
  "link",
  "publish",
  "release",
  "remove",
  "uninstall",
  "upgrade",
  "upload",
  "wget",
])

const REFUSED_PROGRAMS = new Set(["curl", "docker", "kubectl", "nc", "ncat", "scp", "ssh", "wget"])

export class ProofRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProofRefused"
  }
}

export interface ProofResult {
  /** Exactly what containment was applied, recorded with the proof so nobody assumes more. */
  readonly containment: readonly string[]
  readonly demonstrated: boolean
  readonly outcome: RunOutcome
}

/**
 * The reviewer that requests a proof cannot write files — that is the separation of powers working.
 * So it supplies the proof's source, and the control plane writes it inside the disposable copy and
 * nowhere else. No interpreter here is a shell.
 */
const INTERPRETERS: Readonly<Record<string, string>> = {
  node: "mjs",
  perl: "pl",
  php: "php",
  python: "py",
  python3: "py",
  ruby: "rb",
}

const PROOF_DIRECTORY = ".cycle-proof"
const MAX_SCRIPT_BYTES = 64 * 1_024

export interface ProofRequest {
  /** Runs as-is against the copy. Defaults to running the supplied script. */
  readonly command?: string
  readonly interpreter?: string
  readonly script?: string
}

export function assertProofSafe(command: SafeCommand): void {
  const program = command.program
    .replaceAll("\\", "/")
    .split("/")
    .pop()!
    .replace(/\.(exe|cmd|bat|ps1)$/iu, "")
    .toLowerCase()

  if (REFUSED_PROGRAMS.has(program)) {
    throw new ProofRefused(`${program} cannot run inside a proof: a proof has no network and installs nothing`)
  }
  for (const argument of command.arguments) {
    if (REFUSED_ARGUMENTS.has(argument.toLowerCase())) {
      throw new ProofRefused(`${argument} is not permitted in a proof: it installs, fetches or publishes`)
    }
  }
}

/**
 * Runs a security proof against a disposable copy of the candidate. The copy is deleted whatever
 * happens, so nothing a proof writes can ever be promoted.
 *
 * Convention, stated to the reviewer in its prompt: exit code 0 means the vulnerability was
 * demonstrated. Any other exit means it was not.
 */
export async function runProof(root: string, request: ProofRequest): Promise<ProofResult> {
  const interpreter = (request.interpreter ?? "node").toLowerCase()
  const extension = INTERPRETERS[interpreter]
  const script = request.script ?? ""

  if (script && extension === undefined) {
    throw new ProofRefused(
      `${interpreter} is not a proof interpreter; choose one of ${Object.keys(INTERPRETERS).join(", ")}`,
    )
  }
  if (script.length > MAX_SCRIPT_BYTES) {
    throw new ProofRefused(`a proof script is at most ${MAX_SCRIPT_BYTES} bytes`)
  }

  const scriptPath = `${PROOF_DIRECTORY}/proof.${extension ?? "txt"}`
  const commandText = request.command ?? (script ? `${interpreter} ${scriptPath}` : "")
  if (!commandText.trim()) {
    throw new ProofRefused("a proof needs a script to run, or a command to run against the copy")
  }

  let command: SafeCommand
  try {
    command = parseCommand(commandText)
  } catch (error) {
    throw new ProofRefused(error instanceof UnsafeCommand ? error.message : String(error))
  }
  assertProofSafe(command)

  const workspace = await mkdtemp(join(tmpdir(), proofWorkspacePrefix(root)))
  try {
    const copied = await copyCandidate(root, workspace)
    if (script) {
      await mkdir(join(workspace, PROOF_DIRECTORY), { recursive: true })
      await writeFile(join(workspace, scriptPath), script, "utf8")
    }

    const outcome = await runCommand(command, {
      cwd: workspace,
      environment: containedEnvironment(),
      timeoutSeconds: PROOF_TIMEOUT_SECONDS,
    })

    return {
      containment: [
        `disposable copy of ${copied} files, deleted after the run`,
        "environment reduced to the variables an interpreter needs to start",
        "output redacted for secret shapes before it is recorded or returned",
        script ? `proof script written to ${scriptPath} inside the copy only` : "no script written",
        `hard timeout of ${PROOF_TIMEOUT_SECONDS}s`,
        "http and https proxied to a closed loopback port; localhost excluded",
        "package installation, download and publication arguments refused",
        "no shell: program and argument vector only",
      ],
      demonstrated: outcome.unavailable === null && outcome.exitCode === 0,
      // A proof that printed a secret would otherwise put it in the evidence record and in the
      // reviewer's context. What it demonstrated does not depend on the literal bytes.
      outcome: { ...outcome, output: redactSecrets(outcome.output) },
    }
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }
}

/**
 * What an interpreter needs to start, and nothing else. The proof's source is written by a model
 * that has read the repository, so anything reachable from inside the process is reachable by
 * whatever that repository asked it to write: inheriting the whole environment handed every token
 * and key the user happens to have exported to a script chosen by the content under review.
 */
const PASSED_THROUGH = new Set(
  [
    "COMSPEC",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
    "NUMBER_OF_PROCESSORS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR",
  ].map((name) => name.toLowerCase()),
)

/**
 * ponytail: environment-level network denial. It stops every client that honours proxy settings,
 * which is the realistic proof, but a proof opening a raw socket would still reach the network. An
 * OS sandbox — AppContainer on Windows, a namespace on Linux — is the upgrade when a proof needs to
 * run code that is actively hostile rather than merely demonstrative. Until then proofs are off
 * unless the user turns them on.
 */
function containedEnvironment(): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (PASSED_THROUGH.has(name.toLowerCase())) inherited[name] = value
  }

  return {
    ...inherited,
    ALL_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    HTTP_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "localhost,127.0.0.1,::1",
    all_proxy: "http://127.0.0.1:1",
    http_proxy: "http://127.0.0.1:1",
    https_proxy: "http://127.0.0.1:1",
    no_proxy: "localhost,127.0.0.1,::1",
    npm_config_offline: "true",
  }
}

/**
 * Copies what git tracks plus what the executor added, which is exactly the candidate and excludes
 * node_modules, build output and everything else the project ignores.
 *
 * ponytail: a straight copy, capped. A repository above the cap refuses the proof rather than
 * spending minutes copying; a copy-on-write clone is the upgrade if that cap is ever reached in
 * practice.
 */
async function copyCandidate(root: string, workspace: string): Promise<number> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      "git",
      gitArgs(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
      { encoding: "utf8", maxBuffer: 256 * 1_024 * 1_024, shell: false, timeout: GIT_TIMEOUT_MS, windowsHide: true },
    ))
  } catch {
    throw new ProofRefused(
      "the candidate could not be listed: a proof runs against a copy, never against the repository",
    )
  }

  const paths = stdout.split("\0").filter(Boolean)
  if (paths.length > MAX_COPIED_FILES) {
    throw new ProofRefused(
      `the candidate holds ${paths.length} files, above the ${MAX_COPIED_FILES} a disposable copy accepts`,
    )
  }

  let bytes = 0
  let copied = 0
  for (const path of paths) {
    const source = join(root, path)
    const size = await sizeOf(source)
    if (size === null) continue
    bytes += size
    if (bytes > MAX_COPIED_BYTES) {
      throw new ProofRefused(
        `the candidate exceeds the ${MAX_COPIED_BYTES / (1_024 * 1_024)} MiB a disposable copy accepts`,
      )
    }
    const target = join(workspace, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    copied += 1
  }

  return copied
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}
