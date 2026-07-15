package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

func runHook(ctx context.Context, action feature.HookAction) error {
	if action.Command != "" {
		cmd := exec.CommandContext(ctx, "sh", "-c", action.Command)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	if action.Inline != "" {
		cmd := exec.CommandContext(ctx, "sh", "-c", action.Inline)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	return fmt.Errorf("hook has no command or inline")
}
