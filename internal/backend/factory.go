package backend

import (
	"fmt"

	"github.com/anomalyco/sandbox-manager/internal/backend/local"
	"github.com/anomalyco/sandbox-manager/pkg/secret"
)

func Create(name string) secret.SecretBackend {
	switch name {
	case "local":
		return local.New()
	default:
		return nil
	}
}

func CreateStore() secret.SecretBackend {
	return local.New()
}

func CreateManager(name string) (*secret.Manager, error) {
	be := Create(name)
	if be == nil {
		return nil, fmt.Errorf("unknown backend %q", name)
	}

	return secret.NewManager(be, CreateStore()), nil
}
