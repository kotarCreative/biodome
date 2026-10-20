import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Option, Schema } from "effect";
import { ConfigError, RuntimeError } from "./errors.js";
import { EnvSpecSchema, type Plan, validateTargetName } from "./plan.js";
import { EventStore } from "./events.js";

/** Explicit, invocation-scoped selection; never mutates the host environment. */
export const ProfileSelection = Context.Service<{ readonly name?: string }>(
  "@biodome/ProfileSelection",
);

export const ProfileSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  features: Schema.optional(Schema.Array(Schema.String)),
  environment: Schema.optional(Schema.Record(Schema.String, EnvSpecSchema)),
});
export type ProfileDefinition = typeof ProfileSchema.Type;
export const PROFILE_SCOPE_MARKER = "--profile--";

export function validateProfileName(name: string): string {
  validateTargetName(name);
  return name;
}

export const selectedProfile = Effect.fnUntraced(function* (explicit?: string) {
  if (explicit !== undefined) return explicit;
  const selection = yield* Effect.serviceOption(ProfileSelection);
  return Option.isSome(selection) ? selection.value.name : undefined;
});

export const loadProfile = Effect.fnUntraced(function* (rootDir: string, name: string) {
  return yield* Effect.try({
    try: () => {
      validateProfileName(name);
      const path = join(rootDir, ".biodome", "profiles", `${name}.json`);
      const profile = Schema.decodeUnknownSync(ProfileSchema, { onExcessProperty: "error" })(
        JSON.parse(readFileSync(path, "utf8")),
      );
      if (profile.features) {
        profile.features.forEach(validateProfileName);
        if (new Set(profile.features).size !== profile.features.length)
          throw new Error("Profile features must not contain duplicates");
      }
      return profile;
    },
    catch: (error) =>
      new ConfigError({
        message: `Invalid profile "${name}": ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
});

export const listProfiles = Effect.fnUntraced(function* (rootDir: string) {
  const directory = join(rootDir, ".biodome", "profiles");
  const names = yield* Effect.try({
    try: () =>
      existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => name.endsWith(".json"))
            .map((name) => name.slice(0, -5))
            .sort()
        : [],
    catch: (error) => new ConfigError({ message: `Unable to list profiles: ${String(error)}` }),
  });
  return yield* Effect.forEach(names, (name) =>
    loadProfile(rootDir, name).pipe(Effect.map((profile) => ({ name, ...profile }))),
  );
});

/** Stable profile namespace; changing a definition does not lose cleanup ownership. */
export function profileTargetName(target: string, profile?: string): string {
  validateTargetName(target);
  if (target.includes(PROFILE_SCOPE_MARKER))
    throw new Error(`Target names must not contain reserved marker ${PROFILE_SCOPE_MARKER}`);
  if (profile === undefined) return target;
  validateProfileName(profile);
  const hash = createHash("sha256")
    .update(JSON.stringify([target, profile]))
    .digest("hex")
    .slice(0, 8);
  return `${target.slice(0, 18)}${PROFILE_SCOPE_MARKER}${profile.slice(0, 18)}-${hash}`;
}

export function profileFingerprint(plan: Plan, definition: ProfileDefinition): string {
  // References only: resolved credential values never participate in this digest.
  return createHash("sha256")
    .update(JSON.stringify({ definition, build: plan.build, runtime: plan.runtime }))
    .digest("hex");
}

export function assertProfileState(
  plan: Plan,
  state: { profileFingerprint?: string },
): Effect.Effect<void, RuntimeError> {
  if (plan.profile && state.profileFingerprint !== plan.profile.fingerprint) {
    return Effect.fail(
      new RuntimeError({
        message: `Profile "${plan.profile.name}" configuration changed. Stop this profile with "biodome down <target> --profile ${plan.profile.name}", then rebuild with "biodome up <target> --profile ${plan.profile.name} --build". Host secret rotation also requires recreating the environment.`,
      }),
    );
  }
  return Effect.void;
}

export function assertProfileManifest(
  plan: Plan,
  manifest: { provider?: Readonly<Record<string, string>> },
): Effect.Effect<void, RuntimeError> {
  if (
    plan.profile &&
    manifest.provider?.["biodome.profileFingerprint"] !== plan.profile.fingerprint
  ) {
    return Effect.fail(
      new RuntimeError({
        message: `Build manifest does not match profile "${plan.profile.name}". Rebuild this profile before starting or executing commands.`,
      }),
    );
  }
  return Effect.void;
}

export const emitProfileResolved = Effect.fnUntraced(function* (plan: Plan) {
  const store = yield* Effect.serviceOption(EventStore);
  if (plan.profile && Option.isSome(store))
    yield* store.value.emit("profile.resolved", plan.profile, {
      runId: store.value.runId,
      target: plan.deployment?.target.name,
      provider: plan.deployment?.target.driver,
    });
});
