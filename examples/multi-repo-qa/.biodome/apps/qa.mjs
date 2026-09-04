import { computerUse } from "@kotarcreative/biodome/recipes/computer-use";

// Browser QA against the frontend repo's app. baseUrl must be reachable
// from inside the Biodome runtime, so it uses the container-local address.
export default computerUse({
  baseUrl: "http://localhost:4200",
  allowedDomains: ["localhost"],
});
