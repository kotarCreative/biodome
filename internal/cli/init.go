package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/spf13/cobra"
)

func newInitCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "init",
		Short: "Initialize a sandbox/ config directory",
		Long: `Creates a sandbox/ directory with default config files in the current project.

Detects project name from the working directory and generates a minimal
config.yaml that you can extend with services, languages, and tools.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			rootDir, err := os.Getwd()
			if err != nil {
				return fmt.Errorf("get working directory: %w", err)
			}

			// Check if sandbox/ already exists
			existing, err := sandbox.Discover(rootDir)
			if err == nil {
				return fmt.Errorf("sandbox already initialized at %s (use 'sandbox config show' to view)", existing.Dir)
			}
			if _, ok := err.(sandbox.ErrNoSandboxDir); !ok {
				return err
			}

			cfg, err := sandbox.Init(rootDir)
			if err != nil {
				return fmt.Errorf("init sandbox: %w", err)
			}

			fmt.Fprintf(os.Stderr, "Created sandbox/ config directory for %q\n", cfg.Project.Name)
			fmt.Fprintf(os.Stderr, "  %s\n", filepath.Join(cfg.Dir, "config.yaml"))

			return nil
		},
	}
}
