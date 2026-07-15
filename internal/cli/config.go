package cli

import (
	"fmt"
	"os"
	"strings"

	"github.com/anomalyco/sandbox-manager/internal/config"
	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

func newConfigCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "View or modify configuration",
	}

	cmd.AddCommand(&cobra.Command{
		Use:   "show",
		Short: "Show current configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}
			out, err := yaml.Marshal(cfg)
			if err != nil {
				return fmt.Errorf("marshal config: %w", err)
			}
			fmt.Fprint(os.Stdout, string(out))
			return nil
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "validate",
		Short: "Validate the sandbox/ config files",
		RunE: func(cmd *cobra.Command, args []string) error {
			rootDir, err := os.Getwd()
			if err != nil {
				return fmt.Errorf("get working directory: %w", err)
			}

			cfg, err := sandbox.Discover(rootDir)
			if err != nil {
				return err
			}

			errs := sandbox.Validate(cfg)
			if len(errs) == 0 {
				fmt.Fprintln(os.Stderr, "sandbox config is valid")
				return nil
			}

			for _, e := range errs {
				fmt.Fprintf(os.Stderr, "  %s\n", e.Error())
			}
			return fmt.Errorf("%d validation error(s) found", len(errs))
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "set <key> <value>",
		Short: "Set a config value (e.g. 'backend aws')",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}

			switch args[0] {
			case "backend":
				cfg.Backend = args[1]
			default:
				return fmt.Errorf("unknown config key %q; valid keys: backend", args[0])
			}

			// Handle nested keys like "backends.aws.region"
			if strings.Contains(args[0], ".") {
				parts := strings.SplitN(args[0], ".", 2)
				if parts[0] == "backends" {
					if cfg.Backends == nil {
						cfg.Backends = make(map[string]any)
					}
					cfg.Backends[parts[1]] = args[1]
				}
			}

			if err := config.Save(cfg); err != nil {
				return fmt.Errorf("save config: %w", err)
			}
			fmt.Fprintf(os.Stderr, "config updated\n")
			return nil
		},
	})

	return cmd
}
