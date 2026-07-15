package sandbox

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestDefaults(t *testing.T) {
	cfg := DefaultConfig("/tmp/my-project")
	if cfg.Project.Name != "my-project" {
		t.Errorf("expected name 'my-project', got %q", cfg.Project.Name)
	}
	if cfg.Dir != "/tmp/my-project/sandbox" {
		t.Errorf("expected dir '/tmp/my-project/sandbox', got %q", cfg.Dir)
	}
}

func TestInitAndDiscover(t *testing.T) {
	dir := t.TempDir()
	cfg, err := Init(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Project == nil {
		t.Fatal("expected project config")
	}

	discovered, err := Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	if discovered.Project.Name != cfg.Project.Name {
		t.Errorf("expected name %q, got %q", cfg.Project.Name, discovered.Project.Name)
	}
}

func TestDiscoverNoDir(t *testing.T) {
	dir := t.TempDir()
	_, err := Discover(dir)
	if err == nil {
		t.Fatal("expected error for missing sandbox dir")
	}
	if _, ok := err.(ErrNoSandboxDir); !ok {
		t.Fatalf("expected ErrNoSandboxDir, got %T: %v", err, err)
	}
}

func TestDiscoverAllFiles(t *testing.T) {
	dir := t.TempDir()
	sandboxDir := filepath.Join(dir, "sandbox")
	os.MkdirAll(sandboxDir, 0755)

	os.WriteFile(filepath.Join(sandboxDir, "config.yaml"), []byte("name: test-project\n"), 0644)
	os.WriteFile(filepath.Join(sandboxDir, "env.yaml"), []byte("tools:\n  gh: latest\n"), 0644)
	os.WriteFile(filepath.Join(sandboxDir, "services.yaml"), []byte("redis:\n  image: redis:7-alpine\n"), 0644)
	os.WriteFile(filepath.Join(sandboxDir, "hooks.yaml"), []byte("start:\n  post:\n    - command: echo hello\n"), 0644)
	os.WriteFile(filepath.Join(sandboxDir, "secrets.yaml"), []byte("git_ssh_key: ${LOCAL_SSH_AGENT}\n"), 0644)

	cfg, err := Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Project == nil || cfg.Project.Name != "test-project" {
		t.Errorf("unexpected project config: %+v", cfg.Project)
	}
	if cfg.Env == nil || cfg.Env.Tools["gh"] != "latest" {
		t.Errorf("unexpected env config: %+v", cfg.Env)
	}
	if cfg.Services == nil {
		t.Errorf("expected services config")
	}
	if cfg.Hooks == nil {
		t.Errorf("expected hooks config")
	}
	if cfg.Secrets == nil {
		t.Errorf("expected secrets config")
	}
}

func TestValidateValid(t *testing.T) {
	cfg := DefaultConfig("/tmp/test")
	errs := Validate(cfg)
	if len(errs) != 0 {
		t.Errorf("expected no errors, got %v", errs)
	}
}

func TestValidateMissingName(t *testing.T) {
	cfg := DefaultConfig("/tmp/test")
	cfg.Project.Name = ""
	errs := Validate(cfg)
	if len(errs) != 1 {
		t.Fatalf("expected 1 error, got %d: %v", len(errs), errs)
	}
}

func TestDurationMarshal(t *testing.T) {
	d := Duration{Duration: 30 * time.Minute}
	data, err := d.MarshalYAML()
	if err != nil {
		t.Fatal(err)
	}
	if data != "30m0s" {
		t.Errorf("expected '30m0s', got %v", data)
	}
}

func TestDurationUnmarshal(t *testing.T) {
	var d Duration
	fn := func(v any) error {
		*v.(*string) = "45m"
		return nil
	}
	if err := d.UnmarshalYAML(fn); err != nil {
		t.Fatal(err)
	}
	if d.Duration != 45*time.Minute {
		t.Errorf("expected 45m, got %v", d.Duration)
	}
}

func TestInitIdempotent(t *testing.T) {
	dir := t.TempDir()
	_, err := Init(dir)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Init(dir)
	if err == nil {
		t.Fatal("expected error on second init")
	}
}

func TestDiscoverFeatures(t *testing.T) {
	dir := t.TempDir()
	featuresDir := filepath.Join(dir, "sandbox", "features")
	if err := os.MkdirAll(featuresDir, 0755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(featuresDir, "my-redis.yaml"), []byte("type: redis\nport: 6380\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(featuresDir, "my-db.yml"), []byte("type: postgres\nport: 5433\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(featuresDir, "readme.txt"), []byte("not a feature"), 0644); err != nil {
		t.Fatal(err)
	}

	files, err := DiscoverFeatures(dir)
	if err != nil {
		t.Fatalf("DiscoverFeatures failed: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("expected 2 features, got %d", len(files))
	}

	found := map[string]string{}
	for _, f := range files {
		found[f.Name] = f.Type
	}
	if found["my-redis"] != "redis" {
		t.Errorf("expected my-redis type redis, got %v", found)
	}
	if found["my-db"] != "postgres" {
		t.Errorf("expected my-db type postgres, got %v", found)
	}
}

func TestDiscoverFeaturesMissingDir(t *testing.T) {
	dir := t.TempDir()
	files, err := DiscoverFeatures(dir)
	if err != nil {
		t.Fatalf("DiscoverFeatures failed: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("expected 0 features, got %d", len(files))
	}
}

func TestPackageRefUnmarshal(t *testing.T) {
	var cfg EnvConfig
	data := []byte(`
packages:
  npm:
    - typescript
    - name: vite
      version: "5.0"
  pip:
    - pytest
    - name: torch
      version: "2.2"
      index_url: https://download.pytorch.org/whl/cu121
`)
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if len(cfg.Packages.Npm) != 2 {
		t.Fatalf("expected 2 npm packages, got %d", len(cfg.Packages.Npm))
	}
	if cfg.Packages.Npm[0].Name != "typescript" {
		t.Errorf("expected typescript, got %q", cfg.Packages.Npm[0].Name)
	}
	if cfg.Packages.Npm[1].Name != "vite" || cfg.Packages.Npm[1].Version != "5.0" {
		t.Errorf("expected vite@5.0, got %+v", cfg.Packages.Npm[1])
	}

	if len(cfg.Packages.Pip) != 2 {
		t.Fatalf("expected 2 pip packages, got %d", len(cfg.Packages.Pip))
	}
	if cfg.Packages.Pip[0].Name != "pytest" {
		t.Errorf("expected pytest, got %q", cfg.Packages.Pip[0].Name)
	}
	if cfg.Packages.Pip[1].Name != "torch" || cfg.Packages.Pip[1].IndexURL != "https://download.pytorch.org/whl/cu121" {
		t.Errorf("expected torch with custom index, got %+v", cfg.Packages.Pip[1])
	}
}
