package cli

import (
	"fmt"
	"os"

	"github.com/anomalyco/sandbox-manager/internal/docker"
	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/spf13/cobra"
)

func newExecCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "exec <command> [args...]",
		Short: "Run a command inside the workspace",
		Long:  `Executes a command inside the running workspace environment.`,
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			rootDir, err := os.Getwd()
			if err != nil {
				return fmt.Errorf("get working directory: %w", err)
			}

			cfg, err := sandbox.Discover(rootDir)
			if err != nil {
				return err
			}

			runner := docker.NewRunner(cfg.Project.Name)
			return runner.Exec(cmd.Context(), args)
		},
	}
}
