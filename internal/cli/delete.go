package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func newDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <key>",
		Short: "Delete a secret",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			mgr, err := createManager(cmd)
			if err != nil {
				return err
			}

			ctx := context.Background()
			if err := initManager(ctx, mgr); err != nil {
				return fmt.Errorf("init: %w", err)
			}

			if err := mgr.Delete(ctx, args[0]); err != nil {
				return fmt.Errorf("delete: %w", err)
			}

			fmt.Fprintf(os.Stderr, "secret %q deleted\n", args[0])
			return nil
		},
	}
}
