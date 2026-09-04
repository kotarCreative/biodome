import { manualQaTask } from "@kotarcreative/biodome/recipes/computer-use";

export default function manualQa(ctx) {
  ctx.addTask(
    manualQaTask({
      harness: "tester",
      instructions: `
Test the frontend served from the frontend repo and the backend API from the backend repo.
- Load http://localhost:4200 and confirm the expected content renders.
- GET http://localhost:3100/health and confirm it reports healthy.
- Confirm both repos exist under /workspace/repos/.
`,
      requiredProcesses: ["frontend", "backend"],
      timeout: "30m",
    }),
  );
}
