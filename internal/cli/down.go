package cli

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/anomalyco/sandbox-manager/internal/builder"
	"github.com/anomalyco/sandbox-manager/internal/docker"
	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/spf13/cobra"
)

func newDownCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "down",
		Short: "Stop the development environment",
		Long:  `Stops the workspace and all backing services.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			rootDir, err := os.Getwd()
			if err != nil {
				return fmt.Errorf("get working directory: %w", err)
			}

			cfg, err := sandbox.Discover(rootDir)
			if err != nil {
				return err
			}

			plan, err := builder.BuildPlan(cmd.Context(), rootDir, cfg)
			if err != nil {
				return fmt.Errorf("build plan: %w", err)
			}

			// Run pre-stop hooks.
			if len(plan.Runtime.Hooks.StopPre) > 0 {
				for _, action := range plan.Runtime.Hooks.StopPre {
					if err := runHook(cmd.Context(), action); err != nil {
						fmt.Fprintf(os.Stderr, "hook failed: %v\n", err)
					}
				}
			}

			runner := docker.NewRunner(cfg.Project.Name)

			fmt.Fprintln(os.Stderr, "Stopping workspace...")
			if err := runner.StopDev(cmd.Context()); err != nil {
				fmt.Fprintf(os.Stderr, "warning: stop workspace: %v\n", err)
			}

			fmt.Fprintln(os.Stderr, "Stopping services...")
			for _, svc := range plan.Runtime.Services {
				container := runner.PrefixedName(svc.Name)
				stopCtx, cancel := context.WithTimeout(cmd.Context(), 10*time.Second)
				if err := runner.StopContainer(stopCtx, container); err != nil {
					fmt.Fprintf(os.Stderr, "warning: stop %s: %v\n", svc.Name, err)
				}
				cancel()
			}

			fmt.Fprintln(os.Stderr, "Done")
			return nil
		},
	}
}
