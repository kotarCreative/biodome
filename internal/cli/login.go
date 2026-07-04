package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/anomalyco/sandbox-manager/internal/backend/local"
	"github.com/anomalyco/sandbox-manager/pkg/secret"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func newLoginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login [backend]",
		Short: "Authenticate with a backend and store credentials locally",
		Long: `Authenticate with a secret backend (e.g., aws, 1password) and store the
credentials in the local encrypted store for credential chaining.

Subsequent operations will resolve backend credentials from the local store
automatically, so you only need to log in once per machine.

Examples:
  sandbox login aws        # prompts for AWS credentials
  sandbox login 1password  # prompts for 1Password Service Account token`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			backendName := args[0]

			ctx := context.Background()

			localB := local.New()
			localMgr := secret.NewManager(localB)
			if err := localMgr.Init(ctx); err != nil {
				return fmt.Errorf("init local backend: %w", err)
			}

			switch backendName {
			case "aws":
				if err := loginAWS(ctx, localMgr); err != nil {
					return err
				}
			case "1password":
				if err := login1Password(ctx, localMgr); err != nil {
					return err
				}
			default:
				return fmt.Errorf("unsupported backend %q for login", backendName)
			}

			fmt.Fprintf(os.Stderr, "credentials for %q stored in local backend\n", backendName)
			fmt.Fprintf(os.Stderr, "to use this backend: sandbox config set backend %s\n", backendName)
			return nil
		},
	}
}

func loginAWS(ctx context.Context, localMgr *secret.Manager) error {
	fmt.Fprint(os.Stderr, "AWS Access Key ID: ")
	keyID, err := readLine()
	if err != nil {
		return fmt.Errorf("read access key: %w", err)
	}

	fmt.Fprint(os.Stderr, "AWS Secret Access Key: ")
	secretKey, err := readPassword()
	if err != nil {
		return fmt.Errorf("read secret key: %w", err)
	}

	fmt.Fprint(os.Stderr, "AWS Region (default us-east-1): ")
	region, err := readLine()
	if err != nil {
		return fmt.Errorf("read region: %w", err)
	}
	if region == "" {
		region = "us-east-1"
	}

	if err := localMgr.Set(ctx, "aws_access_key_id", keyID); err != nil {
		return err
	}
	if err := localMgr.Set(ctx, "aws_secret_access_key", secretKey); err != nil {
		return err
	}
	if err := localMgr.Set(ctx, "aws_region", region); err != nil {
		return err
	}

	return nil
}

func login1Password(ctx context.Context, localMgr *secret.Manager) error {
	fmt.Fprint(os.Stderr, "1Password Service Account Token: ")
	token, err := readPassword()
	if err != nil {
		return fmt.Errorf("read token: %w", err)
	}

	fmt.Fprint(os.Stderr, "Vault (e.g., company/dev-vault): ")
	vault, err := readLine()
	if err != nil {
		return fmt.Errorf("read vault: %w", err)
	}

	if err := localMgr.Set(ctx, "op_service_account_token", token); err != nil {
		return err
	}
	if err := localMgr.Set(ctx, "op_vault", vault); err != nil {
		return err
	}

	return nil
}

func readLine() (string, error) {
	var s string
	_, err := fmt.Scanln(&s)
	return s, err
}

func readPassword() (string, error) {
	if term.IsTerminal(int(os.Stdin.Fd())) {
		pass, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprint(os.Stderr, "\n")
		if err != nil {
			return "", err
		}
		return string(pass), nil
	}
	return readLine()
}
