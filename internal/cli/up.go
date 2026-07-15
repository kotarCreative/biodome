package cli

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/anomalyco/sandbox-manager/internal/builder"
	"github.com/anomalyco/sandbox-manager/internal/docker"
	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/internal/supervisor"
	"github.com/spf13/cobra"
)

func newUpCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "up",
		Short: "Start the development environment",
		Long: `Starts the runtime environment, including backing services and the
main workspace. Services are brought up with health checks and dependency
ordering.`,
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

			runner := docker.NewRunner(cfg.Project.Name)

			// Prepare environment if requested.
			buildFlag, _ := cmd.Flags().GetBool("build")
			if buildFlag {
				if err := docker.WriteDockerfile(cfg, rootDir); err != nil {
					return fmt.Errorf("prepare environment: %w", err)
				}
				if err := runner.Build(cmd.Context(), rootDir); err != nil {
					return fmt.Errorf("build failed: %w", err)
				}
			}

			// Start backing services.
			var sup *supervisor.Supervisor
			if len(plan.Runtime.Services) > 0 {
				sup, err = runner.StartServices(cmd.Context(), plan)
				if err != nil {
					return fmt.Errorf("start services: %w", err)
				}
				fmt.Fprintln(os.Stderr, "Services ready")
			}

		// Start workspace with runtime env vars.
		if err := runner.StartDev(cmd.Context(), rootDir, plan); err != nil {
			if sup != nil {
				stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				sup.Stop(stopCtx)
			}
			return fmt.Errorf("start workspace: %w", err)
		}
			fmt.Fprintf(os.Stderr, "Workspace %q is running\n", cfg.Project.Name)

			// Run post-start hooks.
			if len(plan.Runtime.Hooks.StartPost) > 0 {
				for _, action := range plan.Runtime.Hooks.StartPost {
					if err := runHook(cmd.Context(), action); err != nil {
						fmt.Fprintf(os.Stderr, "hook failed: %v\n", err)
					}
				}
			}

			// Block until interrupt if --wait flag is set.
			waitFlag, _ := cmd.Flags().GetBool("wait")
			if waitFlag && sup != nil {
				fmt.Fprintln(os.Stderr, "Press Ctrl+C to stop")
				ctx, stop := signal.NotifyContext(cmd.Context(), syscall.SIGINT, syscall.SIGTERM)
				defer stop()
				<-ctx.Done()
				stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				fmt.Fprintln(os.Stderr, "Stopping...")
				runner.StopDev(stopCtx)
				sup.Stop(stopCtx)
			}

			return nil
		},
	}
	cmd.Flags().Bool("build", false, "Prepare the environment before starting")
	cmd.Flags().Bool("wait", false, "Block until Ctrl+C is pressed")
	return cmd
}
