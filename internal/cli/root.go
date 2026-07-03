package cli

import (
	"context"

	"github.com/anomalyco/sandbox-manager/internal/backend"
	"github.com/anomalyco/sandbox-manager/internal/config"
	"github.com/anomalyco/sandbox-manager/pkg/secret"
	"github.com/spf13/cobra"
)

func NewRootCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sandbox",
		Short: "Sandbox Manager - secure secrets management for development environments",
		Long: `A unified secrets manager that works locally and across cloud providers.

Stores secrets encrypted at rest and supports pluggable backends
for AWS Secrets Manager, GCP Secret Manager, 1Password, and more.`,
	}

	pflags := cmd.PersistentFlags()
	pflags.StringP("backend", "b", "", "secret backend to use (default from config)")

	cmd.AddCommand(newSetCmd())
	cmd.AddCommand(newGetCmd())
	cmd.AddCommand(newListCmd())
	cmd.AddCommand(newDeleteCmd())

	return cmd
}

func createManager(cmd *cobra.Command) (*secret.Manager, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}

	backendName := cfg.Backend
	if flag := cmd.Flag("backend"); flag != nil && flag.Changed {
		backendName = flag.Value.String()
	}

	return backend.CreateManager(backendName)
}

func initManager(ctx context.Context, mgr *secret.Manager) error {
	return mgr.Init(ctx)
}
