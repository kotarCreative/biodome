package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func newGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <key>",
		Short: "Retrieve a secret",
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
