package cli

import (
	"fmt"
	"os"

	"github.com/anomalyco/sandbox-manager/internal/docker"
	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/spf13/cobra"
)

func newBuildCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "build",
		Short: "Prepare the development environment",
		Long: `Reads the sandbox/ config and prepares the runtime environment.
This is a one-time setup step; subsequent calls are fast no-ops if nothing
has changed.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			rootDir, err := os.Getwd()
			if err != nil {
				return fmt.Errorf("get working directory: %w", err)
			}

			cfg, err := sandbox.Discover(rootDir)
			if err != nil {
				return err
			}

		if err := docker.WriteDockerfile(cfg, rootDir); err != nil {
			return fmt.Errorf("prepare environment: %w", err)
		}
		if err := docker.WriteCompose(cfg, rootDir); err != nil {
			return fmt.Errorf("prepare environment: %w", err)
		}
		if err := docker.WriteDockerignore(rootDir); err != nil {
			return fmt.Errorf("prepare environment: %w", err)
		}

		runner := docker.NewRunner(cfg.Project.Name)
			if err := runner.Build(cmd.Context(), rootDir); err != nil {
				return fmt.Errorf("build failed: %w", err)
			}
			fmt.Fprintf(os.Stderr, "Environment ready for %q\n", cfg.Project.Name)
			return nil
		},
	}
}
