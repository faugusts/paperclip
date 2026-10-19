// This launcher is admitted by digest and receives a verified native executable.
// Never resolve an executable through PATH or accept command-line overrides.
//
// Mirrors providers/grok/launcher.cjs: the controller passes the digest-verified
// kiro-cli path in PAPERCLIP_KIRO_VERIFIED_EXECUTABLE; we execve it as an ACP
// server over stdio. The kiro-cli session (SSO) lives in the agent HOME/.kiro,
// inherited through the sanitized environment — no API-key env is required.
const { isAbsolute } = require("node:path");
const executable = process.env.PAPERCLIP_KIRO_VERIFIED_EXECUTABLE;
if (!executable || !isAbsolute(executable)) {
  throw new Error("Verified Kiro executable is unavailable");
}
const environment = { ...process.env };
delete environment.PAPERCLIP_KIRO_VERIFIED_EXECUTABLE;

// Descriptor-backed executables (Linux /proc/self/fd/N) must keep their exact
// descriptor in the child; execve preserves the current fd table, so ACP
// stdin/stdout on fd 0/1 are forwarded as-is. The agent engine is pinned to v2
// to match the qualified profile; the ACP client negotiates session/new etc.
process.execve(executable, [executable, "acp", "--agent-engine", "v2"], environment);
