package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/anomalyco/sandbox-manager/internal/backend/local"
	"github.com/anomalyco/sandbox-manager/pkg/secret"
	"github.com/spf13/cobra"
)

func newGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <key>",
		Short: "Retrieve a secret",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			backend := local.New()
			mgr := secret.NewManager(backend)

			ctx := context.Background()
			if err := mgr.Init(ctx); err != nil {
				return fmt.Errorf("init: %w", err)
			}

			val, err := mgr.Resolve(ctx, args[0])
			if err != nil {
				return fmt.Errorf("get: %w", err)
			}

			fmt.Fprint(os.Stdout, val)
			if val[len(val)-1] != '\n' {
				fmt.Fprint(os.Stdout, "\n")
			}
			return nil
		},
	}
}
