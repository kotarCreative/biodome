package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/anomalyco/sandbox-manager/internal/backend/local"
	"github.com/anomalyco/sandbox-manager/pkg/secret"
	"github.com/spf13/cobra"
)

func newSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <key> <value>",
		Short: "Store a secret",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			backend := local.New()
			mgr := secret.NewManager(backend)

			ctx := context.Background()
			if err := mgr.Init(ctx); err != nil {
				return fmt.Errorf("init: %w", err)
			}

			if err := mgr.Set(ctx, args[0], args[1]); err != nil {
				return fmt.Errorf("set: %w", err)
			}

			fmt.Fprintf(os.Stderr, "✓ secret %q stored\n", args[0])
			return nil
		},
	}
}
