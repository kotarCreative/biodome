package sandbox

import (
	"fmt"
	"strings"
)

// ValidationError contains multiple validation issues.
type ValidationError struct {
	File    string
	Issues  []string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.File, strings.Join(e.Issues, "; "))
}

// Validate checks the SandboxConfig for correctness.
// It returns a list of errors; an empty slice means valid.
func Validate(cfg *SandboxConfig) []error {
	var errs []error

	if cfg.Project != nil {
		errs = append(errs, validateProject(cfg.Project)...)
	}
	if cfg.Env != nil {
		errs = append(errs, validateEnv(cfg.Env)...)
	}
	if cfg.Services != nil {
		errs = append(errs, validateServices(cfg.Services)...)
	}
	if cfg.Hooks != nil {
		errs = append(errs, validateHooks(cfg.Hooks)...)
	}
	if cfg.Secrets != nil {
		errs = append(errs, validateSecrets(cfg.Secrets)...)
	}

	return errs
}

func validateProject(pc *ProjectConfig) []error {
	var errs []error

	if pc.Name == "" {
		errs = append(errs, &ValidationError{
			File:   "config.yaml",
			Issues: []string{"name is required"},
		})
	}

	if pc.Build != nil && pc.Build.Cache != nil {
		mode := pc.Build.Cache.Mode
		if mode != "" && mode != "max" && mode != "min" {
			errs = append(errs, &ValidationError{
				File:   "config.yaml",
				Issues: []string{fmt.Sprintf("build.cache.mode must be 'max' or 'min', got %q", mode)},
			})
		}
	}

	if pc.Idle != nil {
		action := pc.Idle.Action
		if action != "" && action != "stop" && action != "snapshot" && action != "hibernate" {
			errs = append(errs, &ValidationError{
				File:   "config.yaml",
				Issues: []string{fmt.Sprintf("idle.action must be 'stop', 'snapshot', or 'hibernate', got %q", action)},
			})
		}
	}

	return errs
}

func validateEnv(ec *EnvConfig) []error {
	var errs []error

	for name, lang := range ec.Languages {
		if lang.Version == "" {
			errs = append(errs, &ValidationError{
				File:   "env.yaml",
				Issues: []string{fmt.Sprintf("languages.%s.version is required", name)},
			})
		}
	}

	validPkgMgrs := map[string]map[string]bool{
		"node":   {"npm": true, "yarn": true, "pnpm": true},
		"python": {"pip": true, "poetry": true, "uv": true, "pipenv": true},
	}

	for name, lang := range ec.Languages {
		if pm := lang.PackageManager; pm != "" {
			valid, ok := validPkgMgrs[name]
			if !ok {
				errs = append(errs, &ValidationError{
					File:   "env.yaml",
					Issues: []string{fmt.Sprintf("languages.%s: unknown package_manager %q for language", name, pm)},
				})
			} else if !valid[pm] {
				errs = append(errs, &ValidationError{
					File:   "env.yaml",
					Issues: []string{fmt.Sprintf("languages.%s.package_manager: %q not valid for %s (valid: npm, yarn, pnpm)", name, pm, name)},
				})
			}
		}
	}

	return errs
}

func validateServices(sc *ServicesConfig) []error {
	var errs []error

	for name, svc := range sc.Services {
		if svc.Port > 0 && (svc.Port < 1 || svc.Port > 65535) {
			errs = append(errs, &ValidationError{
				File:   "services.yaml",
				Issues: []string{fmt.Sprintf("%s.port %d is out of range (1-65535)", name, svc.Port)},
			})
		}
	}

	return errs
}

func validateHooks(hc *HooksConfig) []error {
	var errs []error

	phases := map[string][]HookAction{}
	if hc.Build != nil {
		phases["build.pre"] = hc.Build.Pre
		phases["build.post"] = hc.Build.Post
	}
	if hc.Start != nil {
		phases["start.post"] = hc.Start.Post
	}
	if hc.Stop != nil {
		phases["stop.pre"] = hc.Stop.Pre
	}

	for phase, actions := range phases {
		for i, a := range actions {
			if a.Command == "" && a.Inline == "" {
				errs = append(errs, &ValidationError{
					File:   "hooks.yaml",
					Issues: []string{fmt.Sprintf("%s[%d]: hook must specify 'command' or 'inline'", phase, i)},
				})
			}
		}
	}

	return errs
}

func validateSecrets(sc *SecretsConfig) []error {
	return nil
}
