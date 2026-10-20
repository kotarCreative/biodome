# Deploying to AWS ECS

Biodome can build a repository-defined environment, push it to Amazon ECR, and
run the exact pushed image on ECS Fargate. The ECS target uses an uploaded
workspace: repository files are copied into the immutable image at
`/workspace`; it never depends on a host bind mount.

The driver expects the AWS infrastructure to exist already. Create or select:

- an ECS cluster and ECR repository in one AWS region;
- one or more subnets and at least one security group for Fargate;
- an ECS task execution role trusted by `ecs-tasks.amazonaws.com`;
- optionally, a task role and S3 bucket when named tasks return artifacts.

The machine running Biodome needs Docker with Buildx and AWS credentials. Those
credentials must be able to authenticate and push to ECR, create/read the
run-specific CloudWatch log group and streams, register/run/describe/stop/delete
ECS task definitions and tasks, and pass the configured ECS roles. Artifact
collection also needs read access to the configured S3 objects.

The execution role needs the normal ECR image-pull and CloudWatch Logs
permissions. If the configuration uses `{ secretArn }`, grant that role access
to the referenced Secrets Manager secret or SSM parameter (and its KMS key when
applicable). The optional task role needs `s3:PutObject` for the configured
artifact prefix.

## Declare a target

Create `.biodome/targets/aws.mjs`:

```javascript
export default function aws(ctx) {
  ctx.useRuntime("aws-ecs", {
    region: "ca-central-1",
    cluster: "biodome",
    repository: "123456789012.dkr.ecr.ca-central-1.amazonaws.com/biodome",
    executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
    taskRoleArn: { env: "ECS_TASK_ROLE_ARN" },
    subnets: ["subnet-0123456789abcdef0"],
    securityGroups: ["sg-0123456789abcdef0"],
    assignPublicIp: false,
    cpu: 1024,
    memoryMiB: 2048,
    workspace: { strategy: "upload" },
    artifactBucket: { env: "BIODOME_ECS_ARTIFACT_BUCKET" },
    artifactPrefix: "biodome-artifacts",
    // Optional: use discounted, interruptible placement.
    // capacityProvider: "FARGATE_SPOT",
  });
}
```

`cpu` and `memoryMiB` must be a valid Fargate combination. At least one subnet
and security group are required. With `assignPublicIp: false`, private subnets
must provide outbound access through NAT or suitable VPC endpoints for ECR,
CloudWatch Logs, and any configured Secrets Manager, SSM, or S3 operations.

Store the referenced values without committing them:

```bash
npx @kotarcreative/biodome config env aws
```

The command writes `.biodome/.env`, which Biodome loads without replacing
values already exported by the shell. Keep normal AWS SDK credentials in the
shell, shared AWS config, SSO, a credential process, or the runtime environment;
do not put access keys in the target module.

## Runtime secrets

Host passthrough secrets cannot be forwarded to Fargate. Use an AWS-native
reference instead:

```javascript
export default function secrets(ctx) {
  ctx.addEnv("DATABASE_PASSWORD", {
    from: {
      secretArn: "arn:aws:secretsmanager:ca-central-1:123456789012:secret:database-password-AbCdEf",
    },
    required: true,
  });
}
```

ECS injects the value when the task starts. Biodome persists the ARN, not the
resolved value, in the task definition and local state.

## Deploy and operate

Validate before creating cloud resources, then build and start:

```bash
npx @kotarcreative/biodome target validate aws
npx @kotarcreative/biodome up aws --build
npx @kotarcreative/biodome status aws
npx @kotarcreative/biodome logs aws
```

`up --build` renders the target, builds and pushes the image, records its real
digest, registers that immutable `repository@sha256:...` reference, and waits
until the ECS health check is ready. Recoverable resource identifiers are kept
in `.biodome-build/targets/aws/state.json` during provisioning.

Run an [environment action](actions.md) with the same target:

```bash
npx @kotarcreative/biodome run aws e2e
```

ECS actions are separate one-shot Fargate jobs; in-place `biodome exec` is
not supported. The action command and every declared validation command run in
order inside that same task, so validation observes the job's changed
workspace. When a task declares artifacts, Biodome uploads each declared
workspace-relative path to S3 after validation succeeds and downloads it into
`.biodome-build/targets/aws/artifacts/`. Missing artifacts and upload failures
make the job fail rather than silently returning incomplete output.

Stop the deployment when finished:

```bash
npx @kotarcreative/biodome down aws
```

`down` stops tracked tasks and deregisters and deletes generated task
definitions. If cleanup fails, Biodome retains state so the same command can be
retried. ECR images, CloudWatch log groups, and collected S3 objects are not
deleted by `down`; apply account retention policies that match your needs.

## Current boundary

The provider supports Fargate with the `upload` workspace strategy, egress
networking, native environment/secret injection, CloudWatch container logs,
one-shot named jobs, and S3 artifacts. Host bind mounts, destination network
allowlists, in-place exec, TTL expiry, and process-specific supervisor log files
are rejected or intentionally unsupported.

The implementation has extensive local failure-path coverage, but remains
marked experimental until the repository's opt-in workflow passes against a
real AWS account without leaked tasks or task definitions. Maintainers can run
that proof with:

```bash
BIODOME_AWS_INTEGRATION=1 npm run test:integration -- src/tests/integration/aws-ecs.test.ts
```

See the test header for the complete environment and IAM prerequisites.
