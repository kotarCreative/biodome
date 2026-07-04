package secret

import "context"

type SecretBackend interface {
	Name() string
	Init(ctx context.Context, local SecretBackend) error
	Resolve(ctx context.Context, key string) (string, error)
	List(ctx context.Context) ([]string, error)
	Set(ctx context.Context, key, value string) error
	Delete(ctx context.Context, key string) error
}
