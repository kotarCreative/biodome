package service

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/pkg/healthcheck"
	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
)

func init() {
	RegisterDefinition(&redisDefinition)
}

// RedisConfig is the typed configuration for a Redis service.
type RedisConfig struct {
	Name       string
	Version    string
	Image      string
	Port       int
	Host       string
	Password   string
	Dir        string
	AppendOnly bool
	DataVolume string
}

var redisDefinition = serviceapi.Definition{
	Type: "redis",
	Parse: func(raw any) (any, error) {
		cfg, ok := raw.(sandbox.ServiceConfig)
		if !ok {
			return nil, fmt.Errorf("expected sandbox.ServiceConfig, got %T", raw)
		}
		rc := RedisConfig{
			Version:    cfg.Version,
			Image:      cfg.Image,
			Port:       cfg.Port,
			Host:       cfg.Host,
			DataVolume: cfg.DataVolume,
		}
		if rc.Port == 0 {
			rc.Port = 6379
		}
		if rc.Host == "" {
			rc.Host = "localhost"
		}
		if cfg.Password != nil {
			rc.Password = *cfg.Password
		}
		if rc.Dir == "" {
			rc.Dir = "./.data/redis"
		}
		return rc, nil
	},
	HealthChecker: func(cfg any) (healthcheck.Checker, error) {
		c := cfg.(RedisConfig)
		return healthcheck.RedisPing(c.Host, c.Port, c.Password, 2*time.Second), nil
	},
	ComposeHealthCheck: func(cfg any) *serviceapi.HealthCheck {
		c := cfg.(RedisConfig)
		test := []string{"CMD", "redis-cli", "ping"}
		if c.Password != "" {
			test = []string{"CMD", "redis-cli", "-a", c.Password, "ping"}
		}
		return &serviceapi.HealthCheck{
			Test:     test,
			Interval: "5s",
			Timeout:  "3s",
			Retries:  5,
		}
	},
	ContainerImage: func(cfg any) string {
		c := cfg.(RedisConfig)
		if c.Image != "" {
			return c.Image
		}
		if c.Version != "" {
			return "redis:" + c.Version
		}
		return "redis:7"
	},
	ContainerCommand: func(cfg any) []string {
		return nil
	},
	ContainerEnv: func(cfg any) map[string]string {
		c := cfg.(RedisConfig)
		if c.Password == "" {
			return nil
		}
		return map[string]string{
			"REDIS_PASSWORD": c.Password,
		}
	},
	ContainerPorts: func(cfg any) []serviceapi.PortMapping {
		c := cfg.(RedisConfig)
		return []serviceapi.PortMapping{{Host: c.Port, Container: 6379}}
	},
	ContainerVolumes: func(cfg any) []serviceapi.VolumeMapping {
		c := cfg.(RedisConfig)
		name := c.DataVolume
		if name == "" {
			name = "redis_data"
		}
		return []serviceapi.VolumeMapping{{Host: name, Container: "/data"}}
	},
	DataDir: func(cfg any) string {
		c := cfg.(RedisConfig)
		return c.Dir
	},
	LocalBinary: func(cfg any) string {
		return "redis-server"
	},
	LocalConfigFiles: func(cfg any) (map[string][]byte, error) {
		c := cfg.(RedisConfig)
		var confLines []string
		confLines = append(confLines,
			fmt.Sprintf("port %d", c.Port),
			fmt.Sprintf("dir %s", c.Dir),
			fmt.Sprintf("bind %s", c.Host),
			"daemonize no",
			"save 900 1",
			"save 300 10",
			"save 60 10000",
		)
		if c.AppendOnly {
			confLines = append(confLines, "appendonly yes")
		}
		return map[string][]byte{
			"redis.conf": []byte(strings.Join(confLines, "\n") + "\n"),
		}, nil
	},
	LocalArgs: func(cfg any) []string {
		c := cfg.(RedisConfig)
		path := filepath.Join(c.Dir, "redis.conf")
		args := []string{path}
		if c.Password != "" {
			args = append(args, "--requirepass", c.Password)
		}
		return args
	},
}
