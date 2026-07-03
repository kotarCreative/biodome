package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func newSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <key> <value>",
		Short: "Store a secret",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			mgr, err := createManager(cmd)
			if err != nil {
				return err
			}

			ctx := context.Background()
			if err := initManager(ctx, mgr); err != nil {
				return fmt.Errorf("init: %w", err)
			}

			if err := mgr.Set(ctx, args[0], args[1]); err != nil {
				return fmt.Errorf("set: %w", err)
			}

			fmt.Fprintf(os.Stderr, "secret %q stored\n", args[0])
			return nil
		},
	}
}
