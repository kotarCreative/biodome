package features

import (
	"context"
	"fmt"
	"strings"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

// AptPackagesFeature installs a list of apt packages.
type AptPackagesFeature struct {
	name string
	pkgs []string
}

func newAptPackagesFeature(name string, raw any) (feature.Feature, error) {
	pkgs, ok := raw.([]string)
	if !ok {
		return nil, fmt.Errorf("apt-packages: expected []string, got %T", raw)
	}
	return &AptPackagesFeature{name: name, pkgs: pkgs}, nil
}

func (f *AptPackagesFeature) Name() string { return f.name }
func (f *AptPackagesFeature) Type() string { return "package" }
func (f *AptPackagesFeature) Config() any  { return f.pkgs }
func (f *AptPackagesFeature) Validate() []error {
	return nil
}

func (f *AptPackagesFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	addAptPackage(plan, f.pkgs...)
	_ = ctx
	return nil
}

// NpmPackagesFeature installs npm packages globally.
type NpmPackagesFeature struct {
	name string
	pkgs []sandbox.PackageRef
}

func newNpmPackagesFeature(name string, raw any) (feature.Feature, error) {
	pkgs, err := toPackageRefs(raw)
	if err != nil {
		return nil, fmt.Errorf("npm-packages: %w", err)
	}
	return &NpmPackagesFeature{name: name, pkgs: pkgs}, nil
}

func (f *NpmPackagesFeature) Name() string { return f.name }
func (f *NpmPackagesFeature) Type() string { return "package" }
func (f *NpmPackagesFeature) Config() any  { return f.pkgs }
func (f *NpmPackagesFeature) Validate() []error {
	return nil
}

func (f *NpmPackagesFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	if len(f.pkgs) == 0 {
		return nil
	}
	var names []string
	for _, p := range f.pkgs {
		if p.Version != "" {
			names = append(names, fmt.Sprintf("%s@%s", p.Name, p.Version))
		} else {
			names = append(names, p.Name)
		}
	}
	addLanguageSnippet(plan, fmt.Sprintf("RUN npm install -g %s", strings.Join(names, " ")))
	_ = ctx
	return nil
}

// PipPackagesFeature installs pip packages globally.
type PipPackagesFeature struct {
	name string
	pkgs []sandbox.PackageRef
}

func newPipPackagesFeature(name string, raw any) (feature.Feature, error) {
	pkgs, err := toPackageRefs(raw)
	if err != nil {
		return nil, fmt.Errorf("pip-packages: %w", err)
	}
	return &PipPackagesFeature{name: name, pkgs: pkgs}, nil
}

func (f *PipPackagesFeature) Name() string { return f.name }
func (f *PipPackagesFeature) Type() string { return "package" }
func (f *PipPackagesFeature) Config() any  { return f.pkgs }
func (f *PipPackagesFeature) Validate() []error {
	return nil
}

func (f *PipPackagesFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	if len(f.pkgs) == 0 {
		return nil
	}
	var names []string
	for _, p := range f.pkgs {
		if p.Version != "" {
			names = append(names, fmt.Sprintf("%s==%s", p.Name, p.Version))
		} else {
			names = append(names, p.Name)
		}
	}
	cmd := fmt.Sprintf("RUN pip install --no-cache-dir %s", strings.Join(names, " "))
	if f.pkgs[0].IndexURL != "" {
		cmd = fmt.Sprintf("RUN pip install --no-cache-dir --index-url %s %s", f.pkgs[0].IndexURL, strings.Join(names, " "))
	}
	addLanguageSnippet(plan, cmd)
	_ = ctx
	return nil
}

// NixPackagesFeature installs packages via Nix.
type NixPackagesFeature struct {
	name string
	pkgs []string
}

func newNixPackagesFeature(name string, raw any) (feature.Feature, error) {
	pkgs, ok := raw.([]string)
	if !ok {
		return nil, fmt.Errorf("nix-packages: expected []string, got %T", raw)
	}
	return &NixPackagesFeature{name: name, pkgs: pkgs}, nil
}

func (f *NixPackagesFeature) Name() string { return f.name }
func (f *NixPackagesFeature) Type() string { return "package" }
func (f *NixPackagesFeature) Config() any  { return f.pkgs }
func (f *NixPackagesFeature) Validate() []error {
	return nil
}

func (f *NixPackagesFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	if len(f.pkgs) == 0 {
		return nil
	}
	addLanguageSnippet(plan,
		"RUN curl -fsSL https://nixos.org/nix/install | sh",
		fmt.Sprintf("RUN . /root/.nix-profile/etc/profile.d/nix.sh && nix profile install nixpkgs#%s", strings.Join(f.pkgs, " nixpkgs#")),
	)
	_ = ctx
	return nil
}

// CargoPackagesFeature installs Rust crates globally.
type CargoPackagesFeature struct {
	name string
	pkgs []string
}

func newCargoPackagesFeature(name string, raw any) (feature.Feature, error) {
	pkgs, ok := raw.([]string)
	if !ok {
		return nil, fmt.Errorf("cargo-packages: expected []string, got %T", raw)
	}
	return &CargoPackagesFeature{name: name, pkgs: pkgs}, nil
}

func (f *CargoPackagesFeature) Name() string { return f.name }
func (f *CargoPackagesFeature) Type() string { return "package" }
func (f *CargoPackagesFeature) Config() any  { return f.pkgs }
func (f *CargoPackagesFeature) Validate() []error {
	return nil
}

func (f *CargoPackagesFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	if len(f.pkgs) == 0 {
		return nil
	}
	addLanguageSnippet(plan, fmt.Sprintf("RUN cargo install %s", strings.Join(f.pkgs, " ")))
	_ = ctx
	return nil
}

// GoPackagesFeature installs Go modules globally.
type GoPackagesFeature struct {
	name string
	pkgs []string
}

func newGoPackagesFeature(name string, raw any) (feature.Feature, error) {
	pkgs, ok := raw.([]string)
	if !ok {
		return nil, fmt.Errorf("go-packages: expected []string, got %T", raw)
	}
	return &GoPackagesFeature{name: name, pkgs: pkgs}, nil
}

func (f *GoPackagesFeature) Name() string { return f.name }
func (f *GoPackagesFeature) Type() string { return "package" }
func (f *GoPackagesFeature) Config() any  { return f.pkgs }
func (f *GoPackagesFeature) Validate() []error {
	return nil
}

func (f *GoPackagesFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	if len(f.pkgs) == 0 {
		return nil
	}
	addLanguageSnippet(plan, fmt.Sprintf("RUN go install %s", strings.Join(f.pkgs, " ")))
	_ = ctx
	return nil
}

// GemPackagesFeature installs Ruby gems globally.
type GemPackagesFeature struct {
	name string
	pkgs []string
}

func newGemPackagesFeature(name string, raw any) (feature.Feature, error) {
	pkgs, ok := raw.([]string)
	if !ok {
		return nil, fmt.Errorf("gem-packages: expected []string, got %T", raw)
	}
	return &GemPackagesFeature{name: name, pkgs: pkgs}, nil
}

func (f *GemPackagesFeature) Name() string { return f.name }
func (f *GemPackagesFeature) Type() string { return "package" }
func (f *GemPackagesFeature) Config() any  { return f.pkgs }
func (f *GemPackagesFeature) Validate() []error {
	return nil
}

func (f *GemPackagesFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	if len(f.pkgs) == 0 {
		return nil
	}
	addLanguageSnippet(plan, fmt.Sprintf("RUN gem install %s", strings.Join(f.pkgs, " ")))
	_ = ctx
	return nil
}

// toPackageRefs normalizes raw package config into PackageRefs.
// It accepts []sandbox.PackageRef or []string.
func toPackageRefs(raw any) ([]sandbox.PackageRef, error) {
	if refs, ok := raw.([]sandbox.PackageRef); ok {
		return refs, nil
	}
	if strs, ok := raw.([]string); ok {
		refs := make([]sandbox.PackageRef, 0, len(strs))
		for _, s := range strs {
			refs = append(refs, sandbox.PackageRef{Name: s})
		}
		return refs, nil
	}
	return nil, fmt.Errorf("expected []PackageRef or []string, got %T", raw)
}
