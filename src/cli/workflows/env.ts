import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { Effect } from "effect";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { collectTargetEnvReferences, type TargetEnvProfile } from "../../core/env-collector.js";
import { PlanError } from "../../core/errors.js";
import { mergeDotenv, readDotenv, writeDotenv } from "../../core/dotenv.js";
import { ensureGitignoreEntries } from "../../core/gitignore.js";

const BIODOME_DIR = ".biodome";
const DEFAULT_ENV_FILE = join(BIODOME_DIR, ".env");

export interface EnvConfigOptions {
  readonly targetName?: string;
  readonly envFilePath?: string;
  readonly prompt?: PromptFn;
  readonly output?: NodeJS.WriteStream;
}

export type PromptFn = (question: string, defaultValue?: string) => Promise<string | undefined>;

export interface PromptSession {
  readonly prompt: PromptFn;
  readonly close: () => void;
}

function promptText(question: string, defaultValue?: string): string {
  return defaultValue === undefined ? `${question}: ` : `${question} [keep existing]: `;
}

export function createPromptSession(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): PromptSession {
  if (input.isTTY) {
    let muted = false;
    const hiddenOutput = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted) output.write(chunk);
        callback();
      },
    });
    const rl = createInterface({ input, output: hiddenOutput, terminal: true });
    return {
      prompt: (question, defaultValue) => {
        output.write(promptText(question, defaultValue));
        muted = true;
        rl.setPrompt("");
        return new Promise((resolve) => {
          rl.prompt();
          const onLine = (line: string) => {
            cleanup();
            muted = false;
            output.write("\n");
            const trimmed = line.trim();
            resolve(trimmed === "" ? defaultValue : trimmed);
          };
          const onClose = () => {
            cleanup();
            muted = false;
            output.write("\n");
            resolve(defaultValue);
          };
          rl.once("line", onLine);
          rl.once("close", onClose);
          function cleanup() {
            rl.removeListener("line", onLine);
            rl.removeListener("close", onClose);
          }
        });
      },
      close: () => {
        muted = false;
        rl.close();
        hiddenOutput.destroy();
      },
    };
  }

  // Non-TTY input (piped or redirected): buffer all lines up front and feed
  // them to prompts in order. Blank lines accept the default value.
  const lines: string[] = [];
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const rl = createInterface({ input });
  rl.on("line", (line) => lines.push(line));
  rl.on("close", () => resolveReady?.());
  return {
    prompt: async (question, defaultValue) => {
      output.write(promptText(question, defaultValue));
      await ready;
      const line = lines.shift();
      const value = line === undefined || line.trim() === "" ? defaultValue : line.trim();
      output.write("\n");
      return value;
    },
    close: () => rl.close(),
  };
}

function formatProfiles(profiles: TargetEnvProfile[]): string {
  const lines: string[] = [];
  for (const profile of profiles) {
    lines.push(`Target: ${profile.targetName} (driver: ${profile.driver})`);
    for (const variable of profile.variables) {
      const marker = variable.required ? "required" : "optional";
      const description = variable.description ? ` - ${variable.description}` : "";
      lines.push(`  ${variable.name} (${marker})${description}`);
    }
  }
  return lines.join("\n");
}

function currentValue(
  name: string,
  envFileValues: Readonly<Record<string, string>>,
): string | undefined {
  return process.env[name] ?? envFileValues[name];
}

export function envConfigWorkflow(rootDir: string, options: EnvConfigOptions = {}) {
  return Effect.gen(function* () {
    const envFilePath = options.envFilePath ?? join(rootDir, DEFAULT_ENV_FILE);
    const output = options.output ?? process.stdout;
    const session = yield* Effect.acquireRelease(
      Effect.sync(() =>
        options.prompt
          ? { prompt: options.prompt, close: () => {} }
          : createPromptSession(process.stdin, output),
      ),
      (session) => Effect.sync(session.close),
    );
    const prompt = session.prompt;

    const profiles = yield* Effect.tryPromise({
      try: () => collectTargetEnvReferences(rootDir),
      catch: (error) =>
        new PlanError({
          message: `Failed to scan targets for environment references: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    const filtered = options.targetName
      ? profiles.filter((profile) => profile.targetName === options.targetName)
      : profiles;

    if (filtered.length === 0) {
      const targetHint = options.targetName ? ` for target "${options.targetName}"` : "";
      return {
        message: `No environment variable references found${targetHint}.`,
        wrote: false,
      };
    }

    output.write(`Scanning targets...\n\n${formatProfiles(filtered)}\n\n`);

    const existing = readDotenv(envFilePath);
    const existingValues = Object.fromEntries(existing.entries.map((e) => [e.key, e.value]));
    const updates: Record<string, string> = {};

    for (const profile of filtered) {
      for (const variable of profile.variables) {
        const previous = currentValue(variable.name, existingValues);
        const marker = variable.required ? "required" : "optional";
        const description = variable.description ? ` - ${variable.description}` : "";
        const question = `${variable.name} (${marker})${description}`;
        const answer = yield* Effect.tryPromise({
          try: () => prompt(question, previous),
          catch: (error) =>
            new PlanError({
              message: `Failed to read input for ${variable.name}: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        if (answer !== undefined && answer !== "") {
          updates[variable.name] = answer;
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return { message: "No values entered; .biodome/.env was not changed.", wrote: false };
    }

    yield* Effect.try({
      try: () => {
        ensureGitignoreEntries(rootDir, [".env"]);
        mkdirSync(join(rootDir, BIODOME_DIR), { recursive: true });
        const merged = mergeDotenv(existing, updates);
        writeDotenv(envFilePath, merged);
      },
      catch: (error) =>
        new PlanError({
          message: `Failed to write ${envFilePath}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    return {
      message: `Saved ${Object.keys(updates).length} variable(s) to ${envFilePath}\nBiodome loads this file automatically.`,
      wrote: true,
    };
  }).pipe(Effect.scoped);
}
