package secret

import (
	"context"
	"fmt"
	"sync"
)

type Manager struct {
	mu      sync.RWMutex
	backend SecretBackend
	store   SecretBackend
	cache   map[string]string
}

func NewManager(backend, store SecretBackend) *Manager {
	return &Manager{
		backend: backend,
		store:   store,
		cache:   make(map[string]string),
	}
}

func (m *Manager) Init(ctx context.Context) error {
	return m.backend.Init(ctx, m.store)
}

func (m *Manager) Resolve(ctx context.Context, key string) (string, error) {
	m.mu.RLock()
	val, ok := m.cache[key]
	m.mu.RUnlock()
	if ok {
		return val, nil
	}

	val, err := m.backend.Resolve(ctx, key)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", key, err)
	}

	m.mu.Lock()
	m.cache[key] = val
	m.mu.Unlock()

	return val, nil
}

func (m *Manager) List(ctx context.Context) ([]string, error) {
	return m.backend.List(ctx)
}

func (m *Manager) Set(ctx context.Context, key, value string) error {
	if err := m.backend.Set(ctx, key, value); err != nil {
		return fmt.Errorf("set %s: %w", key, err)
	}
	m.mu.Lock()
	m.cache[key] = value
	m.mu.Unlock()
	return nil
}

func (m *Manager) Delete(ctx context.Context, key string) error {
	if err := m.backend.Delete(ctx, key); err != nil {
		return fmt.Errorf("delete %s: %w", key, err)
	}
	m.mu.Lock()
	delete(m.cache, key)
	m.mu.Unlock()
	return nil
}

func (m *Manager) BackendName() string {
	return m.backend.Name()
}
