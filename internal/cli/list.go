package cli

import (
	"context"
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

func newListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List all stored secrets",
		RunE: func(cmd *cobra.Command, args []string) error {
			mgr, err := createManager(cmd)
			if err != nil {
				return err
			}

			ctx := context.Background()
			if err := initManager(ctx, mgr); err != nil {
				return fmt.Errorf("init: %w", err)
			}

			keys, err := mgr.List(ctx)
			if err != nil {
				return fmt.Errorf("list: %w", err)
			}

			if len(keys) == 0 {
				fmt.Fprintln(os.Stderr, "no secrets stored")
				return nil
			}

			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "KEY\tBACKEND")
			for _, k := range keys {
				fmt.Fprintf(w, "%s\t%s\n", k, mgr.BackendName())
			}
			w.Flush()
			return nil
		},
	}
}
