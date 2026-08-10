import { timingSafeEqual } from "node:crypto";

export function authenticateBearer(
  authorization: string | undefined,
  token: string | null,
): boolean {
  if (token === null) return true;
  if (authorization === undefined) return false;
  const [scheme, candidate, ...rest] = authorization.split(" ");
  if (scheme !== "Bearer" || candidate === undefined || rest.length > 0) return false;
  const expectedBytes = Buffer.from(token);
  const candidateBytes = Buffer.from(candidate);
  return (
    expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes)
  );
}
