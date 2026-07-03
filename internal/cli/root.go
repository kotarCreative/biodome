package cli

import (
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

	cmd.AddCommand(newSetCmd())
	cmd.AddCommand(newGetCmd())
	cmd.AddCommand(newListCmd())
	cmd.AddCommand(newDeleteCmd())

	return cmd
}
