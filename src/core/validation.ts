import { ValidationError } from "./errors.js";

// Validation for plan-sourced values that are interpolated verbatim into
// generated Dockerfiles, supervisord configs, and shell scripts. Features run
// arbitrary host-side JS at plan time, so these checks are defense in depth:
// they primarily reject hand-tampered plan.json files and keep artifact
// consumers injection-safe (see SECURITY.md scope).

// Control characters never belong in interpolated values; newlines would turn
// a value into additional Dockerfile/INI/shell lines.
// oxlint-disable-next-line no-control-regex -- intentional: rejecting control chars
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function fail(label: string, reason: string): never {
  throw new ValidationError({ message: `${label}: ${reason}` });
}

/** Reject control characters (including newline) in an interpolated value. */
export function assertNoControlChars(value: string, label: string): void {
  if (CONTROL_CHARS.test(value)) {
    fail(
      label,
      "must not contain control characters (newlines are not allowed in generated files)",
    );
  }
}

/**
 * A container image reference: optional registry host with port, path
 * segments, tag, and/or `sha256` digest. Examples:
 * `debian:12-slim`, `ghcr.io:443/org/img:1.2`, `img@sha256:abc...`.
 */
export function assertDockerImageRef(ref: string, label = "base image"): void {
  if (!ref || typeof ref !== "string") {
    fail(label, "must be a non-empty string");
  }
  assertNoControlChars(ref, label);
  const digestSuffix = ref.match(/@sha256:([a-f0-9]{64})$/);
  const withoutDigest = digestSuffix ? ref.slice(0, -digestSuffix[0].length) : ref;
  // Registry hosts may include a port and dotted path segments; tags may
  // include separators. Anything outside this set has no legitimate meaning
  // in a FROM line.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(withoutDigest)) {
    fail(
      label,
      `"${ref}" must be an image reference like "debian:12-slim" or "ghcr.io/org/img:1.2"`,
    );
  }
}

/**
 * A language or toolchain version used in image tags and shell commands:
 * `3.12`, `3.12.7`, `22`, `lts-jod`, `pypy3.10-7.3.14`, `nightly-2024-01-01`.
 */
export function assertLanguageVersion(version: string, language: string): void {
  if (!version || typeof version !== "string") {
    fail(`language ${language}`, "version must be a non-empty string");
  }
  assertNoControlChars(version, `language ${language} version`);
  if (!/^[A-Za-z0-9._+-]+$/.test(version)) {
    fail(
      `language ${language}`,
      `version "${version}" must match /^[A-Za-z0-9._+-]+$/ (no shell characters)`,
    );
  }
}

/** An apt package name: lowercase with digits, `+`, `.`, `-`. */
export function assertAptPackageName(name: string): void {
  if (!name || typeof name !== "string") {
    fail("apt package", "requires a non-empty string name");
  }
  assertNoControlChars(name, "apt package name");
  if (!/^[a-z0-9][a-z0-9+.-]*$/.test(name)) {
    fail("apt package", `name "${name}" must match /^[a-z0-9][a-z0-9+.-]*$/`);
  }
}

/**
 * A package name for npm/pip/cargo/gem installs. Scoped npm names
 * (`@scope/pkg`) are allowed; everything else is bare names.
 */
export function assertPackageName(name: string, manager: string): void {
  if (!name || typeof name !== "string") {
    fail(`${manager} package`, "requires a non-empty string name");
  }
  assertNoControlChars(name, `${manager} package name`);
  if (!/^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    fail(
      `${manager} package`,
      `name "${name}" must look like "pkg" or "@scope/pkg" without shell characters`,
    );
  }
}

/** A Go module path such as `golang.org/x/tools/gopls`. */
export function assertGoModulePath(name: string): void {
  if (!name || typeof name !== "string") {
    fail("go package", "requires a non-empty string name");
  }
  assertNoControlChars(name, "go package name");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) ||
    name.split("/").some((segment) => segment === "..")
  ) {
    fail("go package", `module path "${name}" must be a dotted module path without ".." segments`);
  }
}

/** A version/range spec appended to a package install command. */
export function assertPackageVersionSpec(version: string, manager: string): void {
  if (!version || typeof version !== "string") {
    return; // Absent versions are fine; callers omit the flag.
  }
  assertNoControlChars(version, `${manager} package version`);
  // `^`, `~`, and `:` cover npm/pip/caret-style pins without whitespace or
  // shell-active characters.
  if (!/^[A-Za-z0-9._+^:~-]+$/.test(version)) {
    fail(
      `${manager} package`,
      `version "${version}" must match /^[A-Za-z0-9._+^:~-]+$/ (no ranges with spaces or shell characters)`,
    );
  }
}

/** A registry/index URL interpolated into an install command. */
export function assertIndexUrl(url: string, manager: string): void {
  if (!url || typeof url !== "string") {
    fail(`${manager} index URL`, "must be a non-empty string when provided");
  }
  assertNoControlChars(url, `${manager} index URL`);
  // Deliberately excludes shell-active characters that URLs rarely need here:
  // whitespace, quotes, backslash, backtick, `$`, `&`, `;`, `|`, `<`, `>`.
  if (!/^https?:\/\/[A-Za-z0-9._~:/?#@%!+,=[\]()-]+$/.test(url)) {
    fail(`${manager} index URL`, `"${url}" must be an http(s) URL without shell characters`);
  }
}

/**
 * SSH known-hosts material written into a heredoc. The fixed delimiter must
 * never appear as its own line, or the remainder of the material would be
 * interpreted as shell commands inside the sync script.
 */
export const KNOWN_HOSTS_HEREDOC_DELIMITER = "KNOWN_HOSTS_EOF";

export function assertKnownHosts(knownHosts: string): void {
  if (typeof knownHosts !== "string") {
    fail("knownHosts", "must be a string");
  }
  // oxlint-disable-next-line no-control-regex -- intentional: rejecting control chars
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(knownHosts)) {
    fail("knownHosts", "must not contain control characters other than newlines and tabs");
  }
  if (knownHosts.split("\n").some((line) => line === KNOWN_HOSTS_HEREDOC_DELIMITER)) {
    fail(
      "knownHosts",
      `must not contain the reserved heredoc delimiter line ${KNOWN_HOSTS_HEREDOC_DELIMITER}`,
    );
  }
}
