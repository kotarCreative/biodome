import { Context } from "effect";

/** Keep provider progress off stdout when the caller requests a JSON result. */
export const CommandOutput = Context.Service<{ readonly progressToStderr: boolean }>(
  "@biodome/CommandOutput",
);
