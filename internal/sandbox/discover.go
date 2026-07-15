package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	DirName       = "sandbox"
	configFile    = "config.yaml"
	envFile       = "env.yaml"
	servicesFile  = "services.yaml"
	hooksFile     = "hooks.yaml"
	secretsFile   = "secrets.yaml"
	featuresDir   = "features"
)

var filenames = []string{configFile, envFile, servicesFile, hooksFile, secretsFile}

// Discover finds and parses the sandbox/ directory relative to rootDir.
// It returns a SandboxConfig with only the files that exist.
// If the sandbox/ directory does not exist, it returns ErrNoSandboxDir.
func Discover(rootDir string) (*SandboxConfig, error) {
	sandboxDir := filepath.Join(rootDir, DirName)

	info, err := os.Stat(sandboxDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNoSandboxDir{Dir: sandboxDir}
		}
		return nil, fmt.Errorf("stat %s: %w", sandboxDir, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", sandboxDir)
	}

	cfg := &SandboxConfig{Dir: sandboxDir}

	for _, name := range filenames {
		path := filepath.Join(sandboxDir, name)
		if err := parseFile(path, cfg); err != nil {
			return nil, err
		}
	}

	return cfg, nil
}

func parseFile(path string, cfg *SandboxConfig) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read %s: %w", path, err)
	}

	if len(data) == 0 {
		return nil
	}

	base := filepath.Base(path)
	switch base {
	case configFile:
		var pc ProjectConfig
		if err := yaml.Unmarshal(data, &pc); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		cfg.Project = &pc
	case envFile:
		var ec EnvConfig
		if err := yaml.Unmarshal(data, &ec); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		cfg.Env = &ec
	case servicesFile:
		var sc ServicesConfig
		if err := yaml.Unmarshal(data, &sc); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		cfg.Services = &sc
	case hooksFile:
		var hc HooksConfig
		if err := yaml.Unmarshal(data, &hc); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		cfg.Hooks = &hc
	case secretsFile:
		var sc SecretsConfig
		if err := yaml.Unmarshal(data, &sc); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		cfg.Secrets = &sc
	}

	return nil
}

// ErrNoSandboxDir indicates the sandbox/ directory was not found.
type ErrNoSandboxDir struct {
	Dir string
}

func (e ErrNoSandboxDir) Error() string {
	return fmt.Sprintf("sandbox directory not found: %s (run 'sandbox init' to create one)", e.Dir)
}

// DefaultConfig returns a minimal default SandboxConfig for initializing
// a new project. It detects the project name from the working directory.
func DefaultConfig(rootDir string) *SandboxConfig {
	name := filepath.Base(rootDir)
	return &SandboxConfig{
		Dir: filepath.Join(rootDir, DirName),
		Project: &ProjectConfig{
			Name: name,
			Build: &BuildConfig{
				Cache: &CacheConfig{
					Mode: "max",
				},
			},
			Idle: &IdleConfig{
				Timeout: &Duration{Duration: 30 * time.Minute},
				Action:  "stop",
			},
		},
		Env: &EnvConfig{
			Env: map[string]string{
				"LOG_LEVEL": "debug",
			},
		},
		Services: &ServicesConfig{
			Services: make(map[string]ServiceConfig),
		},
	}
}

// Init creates a minimal sandbox/ directory with default config files.
// It returns an error if the directory already exists (use Discover instead).
func Init(rootDir string) (*SandboxConfig, error) {
	existing, err := Discover(rootDir)
	if err == nil {
		return nil, fmt.Errorf("sandbox already initialized at %s", existing.Dir)
	}
	if _, ok := err.(ErrNoSandboxDir); !ok {
		return nil, err
	}

	cfg := DefaultConfig(rootDir)

	if err := os.MkdirAll(cfg.Dir, 0755); err != nil {
		return nil, fmt.Errorf("create sandbox dir: %w", err)
	}

	files := map[string]any{
		configFile: cfg.Project,
	}

	for name, data := range files {
		path := filepath.Join(cfg.Dir, name)
		if err := writeYAML(path, data); err != nil {
			return nil, err
		}
	}

	return cfg, nil
}

func writeYAML(path string, v any) error {
	data, err := yaml.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", path, err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// FeatureFile describes a custom feature discovered in sandbox/features/.
type FeatureFile struct {
	Name string
	Type string
	Raw  map[string]any
}

// DiscoverFeatures finds custom feature files in sandbox/features/*.yaml.
// Each file is parsed as a map and the top-level "type" key determines the
// feature type. The file name (without extension) is the feature name.
func DiscoverFeatures(rootDir string) ([]FeatureFile, error) {
	featuresPath := filepath.Join(rootDir, DirName, featuresDir)

	info, err := os.Stat(featuresPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("stat %s: %w", featuresPath, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", featuresPath)
	}

	entries, err := os.ReadDir(featuresPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", featuresPath, err)
	}

	var files []FeatureFile
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".yaml") && !strings.HasSuffix(name, ".yml") {
			continue
		}
		featureName := strings.TrimSuffix(strings.TrimSuffix(name, ".yaml"), ".yml")
		path := filepath.Join(featuresPath, name)

		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		if len(data) == 0 {
			continue
		}

		var raw map[string]any
		if err := yaml.Unmarshal(data, &raw); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}

		featureType, ok := raw["type"].(string)
		if !ok || featureType == "" {
			return nil, fmt.Errorf("%s: missing or invalid type", path)
		}

		files = append(files, FeatureFile{
			Name: featureName,
			Type: featureType,
			Raw:  raw,
		})
	}

	return files, nil
}
