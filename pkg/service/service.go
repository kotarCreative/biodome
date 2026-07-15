// Package service defines the service contract used by services-runner.
// It lives in pkg/ so that runtime backends and service implementations can
// both depend on it without creating import cycles.
package service

import "context"

// Interface is the contract implemented by every managed service.
type Interface interface {
	Type() string
	Name() string
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	Health(ctx context.Context) error
	Running() bool
}
