// Capability matrix for sandbox runtimes.
// Each backend advertises the set of features it supports so callers can
// inspect capabilities at runtime before invoking optional operations.

/**
 * Known runtime capabilities. The `(string & {})` trick preserves autocomplete
 * while allowing backends to declare custom capabilities without widening the
 * type to plain `string`.
 */
export type Capability =
  | "lifecycle.build"
  | "lifecycle.start"
  | "lifecycle.stop"
  | "lifecycle.restart"
  | "exec.command"
  | "exec.pty"
  | "logs.stream"
  | "status.read"
  | "process.signal"
  | "snapshot.create"
  | "snapshot.restore"
  | "network.policy"
  | "volume.mount"
  | "artifact.collect"
  | (string & {});

/** A read-only set of capabilities advertised by a runtime backend. */
export type Capabilities = ReadonlySet<Capability>;

/** Check whether a runtime advertises a given capability. */
export function hasCapability(capabilities: Capabilities, capability: Capability): boolean {
  return capabilities.has(capability);
}

/** Create a capability set from a list of capability strings. */
export function capabilitiesOf(...capabilities: Array<Capability>): Capabilities {
  return new Set(capabilities);
}
