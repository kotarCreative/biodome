package sandbox

import "time"

// SandboxConfig is the composite of all sandbox/ config files.
type SandboxConfig struct {
	Project  *ProjectConfig  `yaml:"-" json:"-"`
	Env      *EnvConfig      `yaml:"-" json:"-"`
	Services *ServicesConfig `yaml:"-" json:"-"`
	Hooks    *HooksConfig    `yaml:"-" json:"-"`
	Secrets  *SecretsConfig  `yaml:"-" json:"-"`

	Dir string `yaml:"-" json:"-"`
}

// ProjectConfig is parsed from sandbox/config.yaml.
type ProjectConfig struct {
	Name        string       `yaml:"name" json:"name"`
	Description string       `yaml:"description,omitempty" json:"description,omitempty"`
	Version     int          `yaml:"version,omitempty" json:"version,omitempty"`
	Image       string       `yaml:"image,omitempty" json:"image,omitempty"`
	Build       *BuildConfig `yaml:"build,omitempty" json:"build,omitempty"`
	Idle        *IdleConfig  `yaml:"idle,omitempty" json:"idle,omitempty"`
}

type BuildConfig struct {
	Cache *CacheConfig `yaml:"cache,omitempty" json:"cache,omitempty"`
}

type CacheConfig struct {
	Registry string `yaml:"registry" json:"registry"`
	Mode     string `yaml:"mode,omitempty" json:"mode,omitempty"`
}

type IdleConfig struct {
	Timeout *Duration `yaml:"timeout,omitempty" json:"timeout,omitempty"`
	Action  string    `yaml:"action,omitempty" json:"action,omitempty"`
}

// Duration is a wrapper for parsing human-readable durations (e.g. "30m", "1h").
type Duration struct {
	time.Duration
}

func (d Duration) MarshalYAML() (any, error) {
	return d.Duration.String(), nil
}

func (d *Duration) UnmarshalYAML(unmarshal func(any) error) error {
	var s string
	if err := unmarshal(&s); err != nil {
		return err
	}
	parsed, err := time.ParseDuration(s)
	if err != nil {
		return err
	}
	d.Duration = parsed
	return nil
}

// EnvConfig is parsed from sandbox/env.yaml.
type EnvConfig struct {
	Languages map[string]LanguageConfig `yaml:"languages,omitempty" json:"languages,omitempty"`
	Packages  PackageSet                `yaml:"packages,omitempty" json:"packages,omitempty"`
	Tools     map[string]string         `yaml:"tools,omitempty" json:"tools,omitempty"`
	Env       map[string]string         `yaml:"env,omitempty" json:"env,omitempty"`
}

type LanguageConfig struct {
	Version        string            `yaml:"version" json:"version"`
	PackageManager string            `yaml:"package_manager,omitempty" json:"package_manager,omitempty"`
	InstallDeps    *bool             `yaml:"install_deps,omitempty" json:"install_deps,omitempty"`
	GlobalPackages []string          `yaml:"global_packages,omitempty" json:"global_packages,omitempty"`
	Env            map[string]string `yaml:"env,omitempty" json:"env,omitempty"`
	CgoEnabled     *bool             `yaml:"cgo_enabled,omitempty" json:"cgo_enabled,omitempty"`
	BuildCache     *bool             `yaml:"build_cache,omitempty" json:"build_cache,omitempty"`
	Components     []string          `yaml:"components,omitempty" json:"components,omitempty"`
	Targets        []string          `yaml:"targets,omitempty" json:"targets,omitempty"`
	BuildTool      string            `yaml:"build_tool,omitempty" json:"build_tool,omitempty"`
	GradleVersion  string            `yaml:"gradle_version,omitempty" json:"gradle_version,omitempty"`
	Poetry         *PoetryConfig     `yaml:"poetry,omitempty" json:"poetry,omitempty"`
}

type PoetryConfig struct {
	Install     *bool  `yaml:"install,omitempty" json:"install,omitempty"`
	CreateVenV  *bool  `yaml:"create_venv,omitempty" json:"create_venv,omitempty"`
	Config      map[string]string `yaml:"config,omitempty" json:"config,omitempty"`
}

type PackageSet struct {
	Apt  []string      `yaml:"apt,omitempty" json:"apt,omitempty"`
	Nix  []string      `yaml:"nix,omitempty" json:"nix,omitempty"`
	Pip  []PackageRef  `yaml:"pip,omitempty" json:"pip,omitempty"`
	Npm  []PackageRef  `yaml:"npm,omitempty" json:"npm,omitempty"`
	Cargo []string     `yaml:"cargo,omitempty" json:"cargo,omitempty"`
	Go   []string      `yaml:"go,omitempty" json:"go,omitempty"`
	Gem  []string      `yaml:"gem,omitempty" json:"gem,omitempty"`
}

type PackageRef struct {
	Name     string   `yaml:"name" json:"name"`
	Version  string   `yaml:"version,omitempty" json:"version,omitempty"`
	Arch     []string `yaml:"arch,omitempty" json:"arch,omitempty"`
	Global   *bool    `yaml:"global,omitempty" json:"global,omitempty"`
	IndexURL string   `yaml:"index_url,omitempty" json:"index_url,omitempty"`
}

// UnmarshalYAML supports both the simple string form ("typescript") and the
// object form ({name: typescript, version: "5.4"}).
func (p *PackageRef) UnmarshalYAML(unmarshal func(any) error) error {
	var s string
	if err := unmarshal(&s); err == nil {
		p.Name = s
		return nil
	}

	var full struct {
		Name     string   `yaml:"name"`
		Version  string   `yaml:"version,omitempty"`
		Arch     []string `yaml:"arch,omitempty"`
		Global   *bool    `yaml:"global,omitempty"`
		IndexURL string   `yaml:"index_url,omitempty"`
	}
	if err := unmarshal(&full); err != nil {
		return err
	}
	*p = PackageRef(full)
	return nil
}

// ServicesConfig is parsed from sandbox/services.yaml.
type ServicesConfig struct {
	Services map[string]ServiceConfig `yaml:",inline" json:"services"`
}

type ServiceConfig struct {
	Type          string            `yaml:"type,omitempty" json:"type,omitempty"`
	Image         string            `yaml:"image,omitempty" json:"image,omitempty"`
	Version       string            `yaml:"version,omitempty" json:"version,omitempty"`
	Port          int               `yaml:"port,omitempty" json:"port,omitempty"`
	Ports         map[string]int    `yaml:"ports,omitempty" json:"ports,omitempty"`
	Host          string            `yaml:"host,omitempty" json:"host,omitempty"`
	Password      *string           `yaml:"password,omitempty" json:"password,omitempty"`
	Databases     []DatabaseConfig  `yaml:"databases,omitempty" json:"databases,omitempty"`
	Users         []UserConfig      `yaml:"users,omitempty" json:"users,omitempty"`
	RootUser      string            `yaml:"root_user,omitempty" json:"root_user,omitempty"`
	RootPassword  string            `yaml:"root_password,omitempty" json:"root_password,omitempty"`
	Extensions    []string          `yaml:"extensions,omitempty" json:"extensions,omitempty"`
	Settings      map[string]string `yaml:"settings,omitempty" json:"settings,omitempty"`
	InitScript    string            `yaml:"init_script,omitempty" json:"init_script,omitempty"`
	InitSQL       string            `yaml:"init_sql,omitempty" json:"init_sql,omitempty"`
	DataVolume    string            `yaml:"data_volume,omitempty" json:"data_volume,omitempty"`
	Healthcheck   *HealthcheckConfig `yaml:"healthcheck,omitempty" json:"healthcheck,omitempty"`
	Exposed       *bool             `yaml:"exposed,omitempty" json:"exposed,omitempty"`
	Resources     *ResourceConfig   `yaml:"resources,omitempty" json:"resources,omitempty"`
	Buckets       []string          `yaml:"buckets,omitempty" json:"buckets,omitempty"`
	VirtualHosts  []string          `yaml:"virtual_hosts,omitempty" json:"virtual_hosts,omitempty"`
	Collections   []string          `yaml:"collections,omitempty" json:"collections,omitempty"`
	Enabled       *bool             `yaml:"enabled,omitempty" json:"enabled,omitempty"`
}

type DatabaseConfig struct {
	Name       string   `yaml:"name" json:"name"`
	Owner      string   `yaml:"owner,omitempty" json:"owner,omitempty"`
	Extensions []string `yaml:"extensions,omitempty" json:"extensions,omitempty"`
	InitSQL    string   `yaml:"init_sql,omitempty" json:"init_sql,omitempty"`
}

type UserConfig struct {
	Name       string `yaml:"name" json:"name"`
	Password   string `yaml:"password,omitempty" json:"password,omitempty"`
	Privileges string `yaml:"privileges,omitempty" json:"privileges,omitempty"`
	Tags       string `yaml:"tags,omitempty" json:"tags,omitempty"`
}

type HealthcheckConfig struct {
	Test        []string `yaml:"test" json:"test"`
	Interval    string   `yaml:"interval,omitempty" json:"interval,omitempty"`
	Timeout     string   `yaml:"timeout,omitempty" json:"timeout,omitempty"`
	Retries     int      `yaml:"retries,omitempty" json:"retries,omitempty"`
	StartPeriod string   `yaml:"start_period,omitempty" json:"start_period,omitempty"`
}

type ResourceConfig struct {
	Memory string  `yaml:"memory,omitempty" json:"memory,omitempty"`
	CPU    float64 `yaml:"cpu,omitempty" json:"cpu,omitempty"`
}

// HooksConfig is parsed from sandbox/hooks.yaml.
type HooksConfig struct {
	Build *BuildHooks  `yaml:"build,omitempty" json:"build,omitempty"`
	Start *StartHooks  `yaml:"start,omitempty" json:"start,omitempty"`
	Stop  *StopHooks   `yaml:"stop,omitempty" json:"stop,omitempty"`
	Exec  *ExecHooks   `yaml:"exec,omitempty" json:"exec,omitempty"`
	File  *FileHooks   `yaml:"file,omitempty" json:"file,omitempty"`
}

type BuildHooks struct {
	Pre  []HookAction `yaml:"pre,omitempty" json:"pre,omitempty"`
	Post []HookAction `yaml:"post,omitempty" json:"post,omitempty"`
}

type StartHooks struct {
	Post []HookAction `yaml:"post,omitempty" json:"post,omitempty"`
}

type StopHooks struct {
	Pre []HookAction `yaml:"pre,omitempty" json:"pre,omitempty"`
}

type ExecHooks struct {
	Pre  []HookAction `yaml:"pre,omitempty" json:"pre,omitempty"`
	Post []HookAction `yaml:"post,omitempty" json:"post,omitempty"`
}

type FileHooks struct {
	Changed []HookAction `yaml:"changed,omitempty" json:"changed,omitempty"`
}

type HookAction struct {
	Command string `yaml:"command,omitempty" json:"command,omitempty"`
	Inline  string `yaml:"inline,omitempty" json:"inline,omitempty"`
}

// SecretsConfig is parsed from sandbox/secrets.yaml.
type SecretsConfig struct {
	Source string            `yaml:"source,omitempty" json:"source,omitempty"`
	Vault  string            `yaml:"vault,omitempty" json:"vault,omitempty"`
	Items  []string          `yaml:"items,omitempty" json:"items,omitempty"`
	Values map[string]string `yaml:",inline" json:"values,omitempty"`
}
