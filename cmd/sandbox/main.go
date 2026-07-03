package main

import (
	"os"

	"github.com/anomalyco/sandbox-manager/internal/cli"
)

func main() {
	root := cli.NewRootCmd()
	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}
