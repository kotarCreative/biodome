# Processes

## Local Task Execution Flow

When running `biodome run <target> <task>`:

1. **Preflight**:
   - Load target and task plans.
   - Validate required capabilities (e.g., `exec.command` for execution, `artifact.collect` if artifacts are declared).
   - Build the harness command.
2. **Environment Setup**:
   - Render target-scoped files.
   - Build and start the development environment (Docker Compose).
   - Write initial state.
3. **Task Execution**:
   - Emit `task.started`.
   - Execute the generated harness wrapper inside the container.
   - Enforce task-specific timeouts.
   - Capture bounded output.
4. **Completion**:
   - Collect declared artifacts.
   - Emit `task.completed`.
   - Apply cleanup policy (`always`, `on-success`, `never`).
5. **Reporting**:
   - Print result and artifact paths to the CLI.
