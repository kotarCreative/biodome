import { timingSafeEqual } from "node:crypto";

export function authenticateBearer(
  authorization: string | undefined,
  token: string | null,
): boolean {
  // A missing expected token never authorizes. The server fails startup when MCP
  // is enabled without a resolvable token, so this branch is defensive only.
  if (token === null || token === "") return false;
  if (authorization === undefined) return false;
  const [scheme, candidate, ...rest] = authorization.split(" ");
  if (scheme !== "Bearer" || candidate === undefined || rest.length > 0) return false;
  const expectedBytes = Buffer.from(token);
  const candidateBytes = Buffer.from(candidate);
  return (
    expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes)
  );
}
