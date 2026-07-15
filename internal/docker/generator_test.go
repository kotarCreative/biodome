package docker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

func TestGenerateDockerfile_Node(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "package.json"), []byte("{}"), 0644)
	os.WriteFile(filepath.Join(dir, "package-lock.json"), []byte("{}"), 0644)

	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "node-app"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"node": {Version: "20"},
			},
		},
		Services: &sandbox.ServicesConfig{
			Services: map[string]sandbox.ServiceConfig{
				"postgres": {Port: 5432},
			},
		},
	}

	df, err := GenerateDockerfileFromConfig(cfg, dir)
	if err != nil {
		t.Fatalf("GenerateDockerfile failed: %v", err)
	}

	mustContain := []string{
		"FROM node:20-slim AS base",
		"FROM base AS deps",
		"FROM base AS dev",
		"COPY --from=deps /workspace/node_modules /workspace/node_modules",
		"npm ci --prefer-offline",
		"npm cache clean --force",
		"rm -rf /var/lib/apt/lists/*",
	}
	for _, s := range mustContain {
		if !strings.Contains(df, s) {
			t.Errorf("expected Dockerfile to contain %q, got:\n%s", s, df)
		}
	}

	// Final stage should not inherit from deps.
	if strings.Contains(df, "FROM deps AS dev") {
		t.Errorf("dev stage should start from base, not deps:\n%s", df)
	}
}

func TestGenerateDockerfile_PythonPoetry(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "pyproject.toml"), []byte("[tool.poetry]\n"), 0644)
	os.WriteFile(filepath.Join(dir, "poetry.lock"), []byte(""), 0644)

	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "py-app"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"python": {
					Version:        "3.12",
					PackageManager: "poetry",
				},
			},
		},
	}

	df, err := GenerateDockerfileFromConfig(cfg, dir)
	if err != nil {
		t.Fatalf("GenerateDockerfile failed: %v", err)
	}

	mustContain := []string{
		"FROM python:3.12-slim AS base",
		"pip install --no-cache-dir poetry",
		"poetry config virtualenvs.in-project true",
		"poetry install --no-root",
		"poetry cache clear --all pypi",
		"pip cache purge",
		"COPY --from=deps /workspace/.venv /workspace/.venv",
		"ENV PATH=/workspace/.venv/bin:$PATH",
	}
	for _, s := range mustContain {
		if !strings.Contains(df, s) {
			t.Errorf("expected Dockerfile to contain %q, got:\n%s", s, df)
		}
	}
}

func TestGenerateDockerfile_PythonPip(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "requirements.txt"), []byte("requests\n"), 0644)

	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "py-app"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"python": {Version: "3.12"},
			},
		},
	}

	df, err := GenerateDockerfileFromConfig(cfg, dir)
	if err != nil {
		t.Fatalf("GenerateDockerfile failed: %v", err)
	}

	mustContain := []string{
		"python -m venv /workspace/.venv",
		"/workspace/.venv/bin/pip install --no-cache-dir -r requirements.txt",
		"pip cache purge",
		"COPY --from=deps /workspace/.venv /workspace/.venv",
	}
	for _, s := range mustContain {
		if !strings.Contains(df, s) {
			t.Errorf("expected Dockerfile to contain %q, got:\n%s", s, df)
		}
	}
}

func TestGenerateDockerfile_Go(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module example\n"), 0644)
	os.WriteFile(filepath.Join(dir, "go.sum"), []byte(""), 0644)

	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "go-app"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"go": {Version: "1.22"},
			},
		},
	}

	df, err := GenerateDockerfileFromConfig(cfg, dir)
	if err != nil {
		t.Fatalf("GenerateDockerfile failed: %v", err)
	}

	mustContain := []string{
		"FROM golang:1.22-alpine AS base",
		"mkdir -p /workspace/go-mod",
		"go mod download",
		"go clean -cache",
		"COPY --from=deps /workspace/go-mod /go/pkg/mod",
	}
	for _, s := range mustContain {
		if !strings.Contains(df, s) {
			t.Errorf("expected Dockerfile to contain %q, got:\n%s", s, df)
		}
	}
}

func TestGenerateDockerfile_WithServices(t *testing.T) {
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "svc-app"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"go": {Version: "1.22"},
			},
		},
		Services: &sandbox.ServicesConfig{
			Services: map[string]sandbox.ServiceConfig{
				"postgres": {
					Port: 5432,
					Users: []sandbox.UserConfig{
						{Name: "app", Password: "devpassword"},
					},
					Databases: []sandbox.DatabaseConfig{
						{Name: "myapp"},
					},
				},
				"redis": {
					Port:     6379,
					Password: strPtr("devpassword"),
				},
			},
		},
	}

	df, err := GenerateDockerfileFromConfig(cfg, "")
	if err != nil {
		t.Fatalf("GenerateDockerfile failed: %v", err)
	}

	mustContain := []string{
		"postgresql-client",
		"redis-tools",
		"DATABASE_URL=postgresql://app:devpassword@localhost:5432/myapp",
		"REDIS_URL=redis://:devpassword@localhost:6379/0",
	}
	for _, s := range mustContain {
		if !strings.Contains(df, s) {
			t.Errorf("expected Dockerfile to contain %q, got:\n%s", s, df)
		}
	}
}

func TestWriteDockerignore(t *testing.T) {
	dir := t.TempDir()
	if err := WriteDockerignore(dir); err != nil {
		t.Fatalf("WriteDockerignore failed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, ".dockerignore"))
	if err != nil {
		t.Fatalf("reading .dockerignore: %v", err)
	}
	content := string(data)

	mustContain := []string{
		".git",
		"node_modules",
		".venv",
		"target",
		".env",
		".sandbox",
		"Dockerfile",
	}
	for _, s := range mustContain {
		if !strings.Contains(content, s) {
			t.Errorf("expected .dockerignore to contain %q, got:\n%s", s, content)
		}
	}
}

func TestGenerateDockerfile_MissingEnv(t *testing.T) {
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "bad"},
	}
	_, err := GenerateDockerfileFromConfig(cfg, "")
	if err != nil {
		t.Fatalf("expected no error with empty env, got: %v", err)
	}
}

func TestGenerateDockerfile_NoManifests(t *testing.T) {
	dir := t.TempDir()
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "no-deps"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"node": {Version: "20"},
			},
		},
	}

	df, err := GenerateDockerfileFromConfig(cfg, dir)
	if err != nil {
		t.Fatalf("GenerateDockerfile failed: %v", err)
	}

	// Should not generate install or copy commands when no manifest exists.
	if strings.Contains(df, "npm install") {
		t.Errorf("expected no npm install when package.json is missing:\n%s", df)
	}
	if strings.Contains(df, "COPY --from=deps /workspace/node_modules") {
		t.Errorf("expected no node_modules copy when no manifest:\n%s", df)
	}
}

func TestGenerateDockerfile_Pnpm(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "package.json"), []byte("{}"), 0644)
	os.WriteFile(filepath.Join(dir, "pnpm-lock.yaml"), []byte(""), 0644)

	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "pnpm-app"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"node": {
					Version:        "20",
					PackageManager: "pnpm",
				},
			},
		},
	}

	df, err := GenerateDockerfileFromConfig(cfg, dir)
	if err != nil {
		t.Fatalf("GenerateDockerfile failed: %v", err)
	}

	mustContain := []string{
		"corepack enable",
		"pnpm install --frozen-lockfile",
		"pnpm store prune",
	}
	for _, s := range mustContain {
		if !strings.Contains(df, s) {
			t.Errorf("expected Dockerfile to contain %q, got:\n%s", s, df)
		}
	}
}

func TestGenerateDockerfile_ToolsAndPackages(t *testing.T) {
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "tools-pkg-app"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"node": {Version: "20"},
			},
			Packages: sandbox.PackageSet{
				Apt: []string{"curl", "git"},
				Npm: []sandbox.PackageRef{
					{Name: "typescript", Version: "5.4"},
				},
			},
			Tools: map[string]string{
				"gh": "latest",
			},
		},
	}

	df, err := GenerateDockerfileFromConfig(cfg, "")
	if err != nil {
		t.Fatalf("GenerateDockerfile failed: %v", err)
	}

	mustContain := []string{
		"curl",
		"git",
		"gh",
		"npm install -g typescript@5.4",
		"gh --version",
	}
	for _, s := range mustContain {
		if !strings.Contains(df, s) {
			t.Errorf("expected Dockerfile to contain %q, got:\n%s", s, df)
		}
	}
}

func TestGenerateDockerfile_WithProcess(t *testing.T) {
	plan := &feature.Plan{
		Project: "proc-app",
		Build: feature.BuildPlan{
			BaseImage: "python:3.12-slim",
			Environment: make(map[string]string),
		},
		Runtime: feature.RuntimePlan{
			Processes: []feature.Process{
				{
					Name:    "django",
					Command: []string{"python", "manage.py", "runserver", "0.0.0.0:8000"},
					Ports:   []feature.Port{{Host: 8000, Container: 8000}},
					HealthCheck: &feature.ProcessHealthCheck{
						Type: "http",
						URL:  "http://localhost:8000/admin/login/",
					},
				},
			},
		},
	}

	df, err := GenerateDockerfile(plan, "")
	if err != nil {
		t.Fatalf("GenerateDockerfile failed: %v", err)
	}

	mustContain := []string{
		"supervisor",
		"COPY .sandbox/supervisord.conf /workspace/.sandbox/supervisord.conf",
		"CMD [\"supervisord\", \"-c\", \"/workspace/.sandbox/supervisord.conf\"]",
		"curl",
	}
	for _, s := range mustContain {
		if !strings.Contains(df, s) {
			t.Errorf("expected Dockerfile to contain %q, got:\n%s", s, df)
		}
	}

	if strings.Contains(df, "CMD [\"bash\"]") {
		t.Errorf("expected no bash CMD when processes are declared, got:\n%s", df)
	}
}

func TestGenerateSupervisordConf(t *testing.T) {
	plan := &feature.Plan{
		Runtime: feature.RuntimePlan{
			Processes: []feature.Process{
				{
					Name:    "django",
					Command: []string{"python", "manage.py", "runserver", "0.0.0.0:8000"},
					Environment: map[string]string{
						"DEBUG": "1",
					},
				},
				{
					Name:    "mcp",
					Command: []string{"node", "mcp-server.js"},
				},
			},
		},
	}

	conf := GenerateSupervisordConf(plan)
	mustContain := []string{
		"[program:django]",
		"[program:mcp]",
		"command=python manage.py runserver 0.0.0.0:8000",
		"command=node mcp-server.js",
		"DEBUG=\"1\"",
		"[supervisord]",
	}
	for _, s := range mustContain {
		if !strings.Contains(conf, s) {
			t.Errorf("expected supervisord conf to contain %q, got:\n%s", s, conf)
		}
	}
}

func TestWriteSupervisordConf(t *testing.T) {
	dir := t.TempDir()
	plan := &feature.Plan{
		Runtime: feature.RuntimePlan{
			Processes: []feature.Process{
				{
					Name:    "server",
					Command: []string{"node", "server.js"},
				},
			},
		},
	}

	if err := WriteSupervisordConf(plan, dir); err != nil {
		t.Fatalf("WriteSupervisordConf failed: %v", err)
	}

	path := filepath.Join(dir, ".sandbox", "supervisord.conf")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading supervisord.conf: %v", err)
	}
	if !strings.Contains(string(data), "[program:server]") {
		t.Errorf("expected supervisord.conf to contain server program, got:\n%s", string(data))
	}
}

