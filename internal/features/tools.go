package features

import (
	"context"
	"fmt"

	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

// ToolDefinition describes how to install a well-known CLI tool in the
// dev container.
type ToolDefinition struct {
	// AptPackages are Debian packages to install via apt.
	AptPackages []string

	// Script is an optional shell script to run (e.g. curl | sh).
	Script string

	// Verify is an optional command to run after install to confirm it works.
	Verify string

	// Env is environment variables to set in the image.
	Env map[string]string
}

// ToolFeature contributes a single CLI tool to the sandbox.
type ToolFeature struct {
	name    string
	version string
	def     ToolDefinition
}

func newToolFeature(name string, raw any) (feature.Feature, error) {
	version, _ := raw.(string)
	return &ToolFeature{name: name, version: version}, nil
}

func (f *ToolFeature) Name() string { return f.name }
func (f *ToolFeature) Type() string { return "tool" }
func (f *ToolFeature) Config() any  { return f.version }

func (f *ToolFeature) Validate() []error {
	return nil
}

func (f *ToolFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	addAptPackage(plan, f.def.AptPackages...)

	if f.def.Script != "" {
		addLanguageSnippet(plan, fmt.Sprintf("# Install %s", f.name), "RUN "+f.def.Script)
	}
	if f.def.Verify != "" {
		addLanguageSnippet(plan, "RUN "+f.def.Verify)
	}

	for k, v := range f.def.Env {
		plan.Build.Environment[k] = v
	}

	_ = ctx
	return nil
}

// toolDefinitions is the built-in registry of tool install recipes.
var toolDefinitions = map[string]ToolDefinition{
	"gh": {
		AptPackages: []string{"gh"},
		Verify:      "gh --version",
	},
	"aws-cli": {
		AptPackages: []string{"awscli"},
		Verify:      "aws --version",
	},
	"kubectl": {
		Script: "curl -fsSL https://dl.k8s.io/release/stable.txt > /tmp/kubectl-version && curl -fsSL https://dl.k8s.io/release/$(cat /tmp/kubectl-version)/bin/linux/amd64/kubectl -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl",
		Verify: "kubectl version --client",
	},
	"helm": {
		Script: "curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash",
		Verify: "helm version",
	},
	"terraform": {
		Script: "curl -fsSL https://releases.hashicorp.com/terraform/1.7.0/terraform_1.7.0_linux_amd64.zip -o /tmp/terraform.zip && unzip -o /tmp/terraform.zip -d /usr/local/bin/",
		Verify: "terraform -version",
	},
	"docker": {
		AptPackages: []string{"docker.io"},
		Verify:      "docker --version",
	},
	"psql": {
		AptPackages: []string{"postgresql-client"},
		Verify:      "psql --version",
	},
	"redis-cli": {
		AptPackages: []string{"redis-tools"},
		Verify:      "redis-cli --version",
	},
	"vercel": {
		Script: "npm install -g vercel",
		Verify: "vercel --version",
	},
	"wrangler": {
		Script: "npm install -g wrangler",
		Verify: "wrangler --version",
	},
}

// registerTools adds all built-in tool definitions to the registry.
func registerTools(r *feature.Registry) {
	for name, def := range toolDefinitions {
		def := def // capture loop variable
		r.Register(name, func(toolName string, raw any) (feature.Feature, error) {
			feat, err := newToolFeature(toolName, raw)
			if err != nil {
				return nil, err
			}
			tf := feat.(*ToolFeature)
			tf.def = def
			return tf, nil
		})
	}
}

// RegisterTool allows registering a custom tool definition at runtime.
func RegisterTool(r *feature.Registry, name string, def ToolDefinition) {
	r.Register(name, func(toolName string, raw any) (feature.Feature, error) {
		feat, err := newToolFeature(toolName, raw)
		if err != nil {
			return nil, err
		}
		tf := feat.(*ToolFeature)
		tf.def = def
		return tf, nil
	})
}
