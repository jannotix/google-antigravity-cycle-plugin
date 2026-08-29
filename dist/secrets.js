const RULES = [
    { name: "private-key-block", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u },
    { name: "aws-access-key-id", pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/u },
    { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u },
    { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/u },
    { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u },
    { name: "openai-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/u },
    { name: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/u },
    { name: "stripe-key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/u },
    { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u },
    { name: "basic-auth-url", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/u },
];
export function findSecrets(content) {
    const matches = [];
    for (const rule of RULES) {
        const found = rule.pattern.exec(content);
        if (found !== null)
            matches.push({ rule: rule.name, start: found.index });
    }
    return matches;
}
export function containsSecret(content) {
    return RULES.some((rule) => rule.pattern.test(content));
}
export function redactSecrets(content) {
    let redacted = content;
    for (const rule of RULES) {
        redacted = redacted.replace(new RegExp(rule.pattern, "gu"), `[redacted:${rule.name}]`);
    }
    return redacted;
}
