// Package builder converts a SandboxConfig into a feature Plan by discovering
// and invoking feature contributions.
//
// The builder is the bridge between the filesystem-first config (sandbox/*.yaml)
// and the primitive-based feature system. Each file that exists implies a feature
// group, and the builder turns those groups into concrete Feature instances.
package builder

import (
	"context"
	"fmt"
	"sort"

	"github.com/anomalyco/sandbox-manager/internal/features"
	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/internal/service"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

// BuildPlan creates a Plan from the parsed sandbox config and the filesystem.
// It uses the built-in feature registry and discovers custom features from
// sandbox/features/*.yaml.
func BuildPlan(ctx context.Context, rootDir string, cfg *sandbox.SandboxConfig) (*feature.Plan, error) {
	return BuildPlanWithRegistry(ctx, rootDir, features.NewRegistry(), cfg)
}

// BuildPlanWithRegistry creates a Plan from the parsed sandbox config and the
// filesystem using the provided feature registry. This is the extension point
// for custom features.
func BuildPlanWithRegistry(ctx context.Context, rootDir string, registry *feature.Registry, cfg *sandbox.SandboxConfig) (*feature.Plan, error) {
	plan := &feature.Plan{
		Project: cfg.Project.Name,
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
		Runtime: feature.RuntimePlan{
			Environment: make(map[string]string),
			Networks:    []feature.Network{{Name: "sandbox", Driver: "bridge"}},
			Volumes:     []feature.Volume{},
		},
		Agents: feature.AgentPlan{},
	}

	// Contribute environment features (languages, packages, tools, env vars).
	if err := contributeEnv(ctx, registry, cfg.Env, plan); err != nil {
		return nil, fmt.Errorf("env: %w", err)
	}

	// Contribute service features.
	if err := contributeServices(ctx, registry, cfg.Services, plan); err != nil {
		return nil, fmt.Errorf("services: %w", err)
	}

	// Contribute custom features from sandbox/features/*.yaml.
	if err := contributeFeatures(ctx, rootDir, registry, plan); err != nil {
		return nil, fmt.Errorf("features: %w", err)
	}

	// Contribute hook features.
	if err := contributeHooks(ctx, cfg.Hooks, plan); err != nil {
		return nil, fmt.Errorf("hooks: %w", err)
	}

	// Generate service connection strings after all services have contributed.
	if err := generateServiceEnvVars(plan); err != nil {
		return nil, fmt.Errorf("service env vars: %w", err)
	}

	// Add service client packages for the Dockerfile.
	addServiceClientPackages(plan)

	return plan, nil
}

// addServiceClientPackages adds apt packages for service CLI clients based on
// the service types in the runtime plan.
func addServiceClientPackages(plan *feature.Plan) {
	for _, svc := range plan.Runtime.Services {
		var pkg string
		switch svc.Type {
		case "postgres":
			pkg = "postgresql-client"
		case "redis":
			pkg = "redis-tools"
		case "mysql":
			pkg = "default-mysql-client"
		case "mongodb":
			pkg = "mongodb-clients"
		}
		if pkg == "" {
			continue
		}
		addAptPackages(plan, pkg)
	}
}

// addAptPackages adds unique apt packages to the build plan.
func addAptPackages(plan *feature.Plan, pkgs ...string) {
	seen := make(map[string]struct{}, len(plan.Build.AptPackages))
	for _, pkg := range plan.Build.AptPackages {
		seen[pkg] = struct{}{}
	}
	for _, pkg := range pkgs {
		if _, ok := seen[pkg]; ok {
			continue
		}
		seen[pkg] = struct{}{}
		plan.Build.AptPackages = append(plan.Build.AptPackages, pkg)
	}
}

func contributeEnv(ctx context.Context, registry *feature.Registry, env *sandbox.EnvConfig, plan *feature.Plan) error {
	if env == nil {
		return nil
	}

	for k, v := range env.Env {
		plan.Build.Environment[k] = v
		plan.Runtime.Environment[k] = v
	}

	// Language features are created from the registry so they can be customized.
	// Iterate in sorted order so the base image selection is deterministic.
	langNames := make([]string, 0, len(env.Languages))
	for langName := range env.Languages {
		langNames = append(langNames, langName)
	}
	sort.Strings(langNames)
	for _, langName := range langNames {
		langCfg := env.Languages[langName]
		feat, err := registry.Create(langName, langName, langCfg)
		if err != nil {
			return fmt.Errorf("language %s: %w", langName, err)
		}
		if err := feat.Contribute(ctx, plan); err != nil {
			return fmt.Errorf("language %s: %w", langName, err)
		}
	}

	// Package features contribute language-specific packages.
	if err := contributePackageFeatures(ctx, registry, env.Packages, plan); err != nil {
		return fmt.Errorf("packages: %w", err)
	}

	// Tool features contribute well-known CLI tools.
	if err := contributeToolFeatures(ctx, registry, env.Tools, plan); err != nil {
		return fmt.Errorf("tools: %w", err)
	}

	// Default base image when no language is configured.
	if plan.Build.BaseImage == "" {
		plan.Build.BaseImage = "ubuntu:22.04"
	}

	_ = ctx
	return nil
}

func contributePackageFeatures(ctx context.Context, registry *feature.Registry, packages sandbox.PackageSet, plan *feature.Plan) error {
	featureMap := map[string]any{
		"apt-packages":    packages.Apt,
		"npm-packages":    packages.Npm,
		"pip-packages":    packages.Pip,
		"nix-packages":    packages.Nix,
		"cargo-packages":  packages.Cargo,
		"go-packages":     packages.Go,
		"gem-packages":    packages.Gem,
	}

	for typeName, cfg := range featureMap {
		// Skip empty package sets.
		switch v := cfg.(type) {
		case []string:
			if len(v) == 0 {
				continue
			}
		case []sandbox.PackageRef:
			if len(v) == 0 {
				continue
			}
		default:
			continue
		}

		feat, err := registry.Create(typeName, typeName, cfg)
		if err != nil {
			return fmt.Errorf("%s: %w", typeName, err)
		}
		if err := feat.Contribute(ctx, plan); err != nil {
			return fmt.Errorf("%s: %w", typeName, err)
		}
	}

	return nil
}

func contributeToolFeatures(ctx context.Context, registry *feature.Registry, tools map[string]string, plan *feature.Plan) error {
	toolNames := make([]string, 0, len(tools))
	for name := range tools {
		toolNames = append(toolNames, name)
	}
	sort.Strings(toolNames)

	for _, name := range toolNames {
		version := tools[name]
		feat, err := registry.Create(name, name, version)
		if err != nil {
			return fmt.Errorf("tool %s: %w", name, err)
		}
		if err := feat.Contribute(ctx, plan); err != nil {
			return fmt.Errorf("tool %s: %w", name, err)
		}
	}

	return nil
}

func contributeServices(ctx context.Context, registry *feature.Registry, services *sandbox.ServicesConfig, plan *feature.Plan) error {
	if services == nil {
		return nil
	}

	for name, svcCfg := range services.Services {
		svcType := service.DetectType(name, svcCfg)
		if svcType == "" {
			return fmt.Errorf("cannot detect service type for %q", name)
		}

		feat, err := registry.Create(svcType, name, svcCfg)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}

		if err := feat.Contribute(ctx, plan); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}

	return nil
}

func contributeFeatures(ctx context.Context, rootDir string, registry *feature.Registry, plan *feature.Plan) error {
	files, err := sandbox.DiscoverFeatures(rootDir)
	if err != nil {
		return err
	}

	for _, f := range files {
		feat, err := registry.Create(f.Type, f.Name, f.Raw)
		if err != nil {
			return fmt.Errorf("%s: %w", f.Name, err)
		}
		if err := feat.Contribute(ctx, plan); err != nil {
			return fmt.Errorf("%s: %w", f.Name, err)
		}
	}

	return nil
}

func contributeHooks(ctx context.Context, hooks *sandbox.HooksConfig, plan *feature.Plan) error {
	if hooks == nil {
		return nil
	}

	convert := func(actions []sandbox.HookAction) []feature.HookAction {
		out := make([]feature.HookAction, 0, len(actions))
		for _, a := range actions {
			out = append(out, feature.HookAction{Command: a.Command, Inline: a.Inline})
		}
		return out
	}

	if hooks.Build != nil {
		plan.Runtime.Hooks.BuildPre = convert(hooks.Build.Pre)
		plan.Runtime.Hooks.BuildPost = convert(hooks.Build.Post)
	}
	if hooks.Start != nil {
		plan.Runtime.Hooks.StartPost = convert(hooks.Start.Post)
	}
	if hooks.Stop != nil {
		plan.Runtime.Hooks.StopPre = convert(hooks.Stop.Pre)
	}
	if hooks.Exec != nil {
		plan.Runtime.Hooks.ExecPre = convert(hooks.Exec.Pre)
		plan.Runtime.Hooks.ExecPost = convert(hooks.Exec.Post)
	}

	_ = ctx
	return nil
}

// generateServiceEnvVars creates connection-string env vars from the services
// in the plan. This is a transitional helper; eventually each service feature
// will contribute its own env vars.
func generateServiceEnvVars(plan *feature.Plan) error {
	for _, svc := range plan.Runtime.Services {
		switch svc.Type {
		case "postgres":
			user := "postgres"
			password := "postgres"
			db := "postgres"

			// Extract from the service environment if present.
			if svc.Environment != nil {
				if u, ok := svc.Environment["POSTGRES_USER"]; ok {
					user = u
				}
				if p, ok := svc.Environment["POSTGRES_PASSWORD"]; ok {
					password = p
				}
				if d, ok := svc.Environment["POSTGRES_DB"]; ok {
					db = d
				}
			}

			var port int
			for _, p := range svc.Ports {
				if p.Container == 5432 {
					port = p.Host
					break
				}
			}
			if port == 0 {
				port = 5432
			}

			plan.Runtime.Environment["DATABASE_URL"] = fmt.Sprintf(
				"postgresql://%s:%s@%s:%d/%s", user, password, svc.Name, port, db,
			)
			plan.Build.Environment["DATABASE_URL"] = fmt.Sprintf(
				"postgresql://%s:%s@localhost:%d/%s", user, password, port, db,
			)

		case "redis":
			password := ""
			if svc.Environment != nil {
				password = svc.Environment["REDIS_PASSWORD"]
			}

			var port int
			for _, p := range svc.Ports {
				if p.Container == 6379 {
					port = p.Host
					break
				}
			}
			if port == 0 {
				port = 6379
			}

			if password != "" {
				plan.Runtime.Environment["REDIS_URL"] = fmt.Sprintf(
					"redis://:%s@%s:%d/0", password, svc.Name, port,
				)
				plan.Build.Environment["REDIS_URL"] = fmt.Sprintf(
					"redis://:%s@localhost:%d/0", password, port,
				)
			} else {
				plan.Runtime.Environment["REDIS_URL"] = fmt.Sprintf(
					"redis://%s:%d/0", svc.Name, port,
				)
				plan.Build.Environment["REDIS_URL"] = fmt.Sprintf(
					"redis://localhost:%d/0", port,
				)
			}
		}
	}

	return nil
}
