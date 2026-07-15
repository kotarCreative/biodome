package cli

import (
	"github.com/spf13/cobra"
)

func newSecretCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "secret",
		Short: "Manage secrets in the configured backend",
		Long:  `Store, retrieve, and delete secrets using the local encrypted store or a remote backend like AWS Secrets Manager.`,
	}

	cmd.AddCommand(newSetCmd())
	cmd.AddCommand(newGetCmd())
	cmd.AddCommand(newListCmd())
	cmd.AddCommand(newDeleteCmd())
	cmd.AddCommand(newLoginCmd())

	return cmd
}
