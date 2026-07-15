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
		Short: "Sandbox Manager - declarative development environments",
		Long: `A declarative development environment manager.

Reads sandbox/ config files and provisions a reproducible workspace
with languages, tools, and backing services. The runtime is opaque:
you configure what you need, and the tool handles the rest.

Includes a pluggable secret store with local encrypted storage
and AWS Secrets Manager support.`,
	}

	pflags := cmd.PersistentFlags()
	pflags.StringP("backend", "b", "", "secret backend to use (default from config)")

	cmd.AddCommand(newInitCmd())
	cmd.AddCommand(newBuildCmd())
	cmd.AddCommand(newUpCmd())
	cmd.AddCommand(newDownCmd())
	cmd.AddCommand(newExecCmd())
	cmd.AddCommand(newConfigCmd())
	cmd.AddCommand(newSecretCmd())

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
