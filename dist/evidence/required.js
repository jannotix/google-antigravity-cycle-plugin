import { DEFAULT_TIMEOUT_SECONDS } from "./gates.js";
const DEPENDENCY_MANIFEST = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|poetry\.lock|requirements[^/]*\.txt|Gemfile|Gemfile\.lock|composer\.json|composer\.lock|pom\.xml|build\.gradle[^/]*)$/iu;
const INTERFACE_FILE = /\.(tsx|jsx|vue|svelte|css|html)$|(^|\/)(components|pages|frontend)(\/|$)/iu;
const SECURITY_SURFACE = /(^|[/\-_.])(auth|authn|authz|login|signin|session|sessions|token|tokens|permission|permissions|role|roles|rbac|crypto|password|passwords|secret|secrets|credential|credentials|sanitize|sanitizer|sanitise|validation|validator|escape)([/\-_.]|$)/iu;
const REQUIREMENTS = [
    {
        kind: "database",
        name: "database:real-integration",
        paths: /(^|\/)(migrations?|db|schema)(\/|$)|\.sql$|(^|[/\-_.])schema([/\-_.]|$)/iu,
        reason: "the change touches persistence and no gate exercises a real database",
        supplied: /\b(migrat|integration|testcontainer|dbmate|flyway|liquibase|alembic|sqitch|prisma)/iu,
    },
    {
        kind: "browser",
        name: "browser:affected-user-flow",
        paths: INTERFACE_FILE,
        reason: "the change touches the interface and no gate drives the affected user flow",
        supplied: /\b(playwright|cypress|puppeteer|webdriver|selenium|e2e)/iu,
    },
    {
        kind: "browser",
        name: "accessibility:affected-user-flow",
        paths: INTERFACE_FILE,
        reason: "the change touches the interface and no gate checks the affected flow for accessibility",
        supplied: /\b(axe|a11y|accessib|pa11y|lighthouse)/iu,
    },
    {
        kind: "security",
        name: "security:dependency-vulnerability",
        paths: DEPENDENCY_MANIFEST,
        reason: "the change alters dependencies and no gate audits them for known vulnerabilities",
        supplied: /\b(audit|osv|snyk|trivy|grype|safety|pip-audit|cargo-deny|govulncheck)/iu,
    },
    {
        kind: "security",
        name: "security:dependency-license",
        paths: DEPENDENCY_MANIFEST,
        reason: "the change alters dependencies and no gate checks their licences",
        supplied: /\b(licen[cs]e|cargo-deny|license-checker|licensed|reuse)/iu,
    },
    {
        kind: "package",
        name: "package:production-artifact",
        paths: /(^|\/)(installer|packaging|release)(\/|$)|(^|\/)Dockerfile(\.|$)/iu,
        reason: "the change touches packaging and no gate builds and checks the production artifact",
        supplied: /\b(pack|bundle|dist|docker|installer|msi|notariz|codesign)/iu,
    },
    {
        kind: "security",
        name: "security:executed-proof",
        paths: SECURITY_SURFACE,
        reason: "the change touches authentication, authorization, input handling or secrets and no gate " +
            "executes a proof against it",
        supplied: /\b(zap|nuclei|semgrep|bandit|gosec|snyk|security)/iu,
    },
];
export function requiredMissingGates(changed, discovered, strictness, alreadyRecorded = []) {
    const paths = changed.map((file) => file.path);
    const invocations = discovered.map((gate) => `${gate.name} ${gate.invocation}`);
    const recorded = new Set(alreadyRecorded);
    const gates = [];
    for (const requirement of REQUIREMENTS) {
        const touched = paths.filter((path) => requirement.paths.test(path));
        if (touched.length === 0)
            continue;
        if (recorded.has(requirement.name))
            continue;
        if (invocations.some((invocation) => requirement.supplied.test(invocation)))
            continue;
        gates.push({
            executor: { kind: "unavailable", reason: requirement.reason },
            invocation: "",
            kind: requirement.kind,
            mandatory: strictness !== "advisory",
            name: requirement.name,
            precondition: `${requirement.reason}: ${touched.slice(0, 5).join(", ")}`,
            timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        });
    }
    return gates;
}
