package supervisor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/anomalyco/sandbox-manager/pkg/graph"
	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
)

const (
	DefaultStartTimeout       = 30 * time.Second
	DefaultCheckInterval      = 5 * time.Second
	DefaultMaxBackoff         = 30 * time.Second
	DefaultInitialBackoff     = 500 * time.Millisecond
	DefaultHealthPollInterval = 500 * time.Millisecond
)

type restartState struct {
	count int
	wait  time.Duration
}

type Supervisor struct {
	services      map[string]serviceapi.Interface
	waves         [][]string
	startTimeout  time.Duration
	checkInterval time.Duration
	maxBackoff    time.Duration
	restarts      map[string]*restartState
	starting      map[string]bool
	events        *EventLog
	mu            sync.Mutex
}

// New creates a supervisor that starts services in parallel while respecting
// dependency order. deps maps a service name to the names of services it
// depends on.
func New(services []serviceapi.Interface, deps map[string][]string, logsDir string) (*Supervisor, error) {
	eventsPath := filepath.Join(logsDir, "events.log")

	svcMap := make(map[string]serviceapi.Interface, len(services))
	for _, svc := range services {
		if _, exists := svcMap[svc.Name()]; exists {
			return nil, fmt.Errorf("duplicate service name %q", svc.Name())
		}
		svcMap[svc.Name()] = svc
	}

	graphDeps := make(map[string][]string, len(services))
	for name := range svcMap {
		graphDeps[name] = nil
	}
	for name, dependencies := range deps {
		if _, ok := svcMap[name]; !ok {
			return nil, fmt.Errorf("dependency declared for unknown service %q", name)
		}
		graphDeps[name] = dependencies
	}

	g := graph.New(graphDeps)
	waves, err := g.Waves()
	if err != nil {
		return nil, err
	}

	return &Supervisor{
		services:      svcMap,
		waves:         waves,
		startTimeout:  DefaultStartTimeout,
		checkInterval: DefaultCheckInterval,
		maxBackoff:    DefaultMaxBackoff,
		restarts:      make(map[string]*restartState),
		starting:      make(map[string]bool),
		events:        NewEventLog(eventsPath),
	}, nil
}

// Start launches services in dependency waves. Each wave is started in parallel,
// and the next wave is not started until every service in the current wave is
// healthy. It returns a channel that is closed once all waves have completed (or
// a wave has failed).
func (s *Supervisor) Start(ctx context.Context) <-chan error {
	allReady := make(chan error, 1)

	go func() {
		var errs []error
		for _, wave := range s.waves {
			waveErrs := s.startWave(ctx, wave)
			if len(waveErrs) > 0 {
				errs = append(errs, waveErrs...)
				break
			}
		}
		if len(errs) > 0 {
			allReady <- fmt.Errorf("startup errors: %w", errors.Join(errs...))
		}
		close(allReady)
	}()

	return allReady
}

func (s *Supervisor) startWave(ctx context.Context, wave []string) []error {
	if len(wave) == 0 {
		return nil
	}

	type result struct {
		name string
		err  error
	}

	results := make(chan result, len(wave))

	for _, name := range wave {
		svc := s.services[name]
		go func() {
			s.markStarting(svc.Name(), true)
			slog.Info("starting service", "name", svc.Name(), "type", svc.Type())
			s.events.write(Event{
				Timestamp: time.Now(),
				Event:     EventStarted,
				Service:   svc.Name(),
				Message:   fmt.Sprintf("starting %s", svc.Type()),
			})

			if err := svc.Start(ctx); err != nil {
				results <- result{svc.Name(), fmt.Errorf("start: %w", err)}
				s.markStarting(svc.Name(), false)
				return
			}

			deadline := time.Now().Add(s.startTimeout)
			for {
				if time.Now().After(deadline) {
					results <- result{svc.Name(), fmt.Errorf("health check timed out after %v", s.startTimeout)}
					s.markStarting(svc.Name(), false)
					return
				}

				if err := svc.Health(ctx); err == nil {
					s.events.write(Event{
						Timestamp: time.Now(),
						Event:     EventHealthy,
						Service:   svc.Name(),
						Message:   fmt.Sprintf("%s is healthy", svc.Type()),
					})
					s.resetBackoff(svc.Name())
					s.markStarting(svc.Name(), false)
					slog.Info("service healthy", "name", svc.Name())
					results <- result{svc.Name(), nil}
					return
				}

				select {
				case <-ctx.Done():
					results <- result{svc.Name(), ctx.Err()}
					s.markStarting(svc.Name(), false)
					return
				case <-time.After(DefaultHealthPollInterval):
				}
			}
		}()
	}

	var errs []error
	for range wave {
		r := <-results
		if r.err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", r.name, r.err))
		}
	}

	return errs
}

// WaitForReady blocks until all services started by Start are healthy, or until
// ctx is cancelled. It returns the first startup error, if any.
func (s *Supervisor) WaitForReady(ctx context.Context, allReady <-chan error) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err, ok := <-allReady:
		if ok && err != nil {
			return err
		}
		return nil
	}
}

// Supervise monitors the health of all services and restarts crashed services
// with exponential backoff. The backoff resets when a service passes a health
// check after a restart. The loop runs until ctx is cancelled.
func (s *Supervisor) Supervise(ctx context.Context) {
	ticker := time.NewTicker(s.checkInterval)
	defer ticker.Stop()

	slog.Info("supervision started")

	for {
		select {
		case <-ctx.Done():
			slog.Info("supervision stopped", "reason", ctx.Err())
			return
		case <-ticker.C:
			for _, svc := range s.services {
				if !svc.Running() {
					if s.isStarting(svc.Name()) {
						continue
					}
					s.handleCrash(ctx, svc)
				} else {
					if err := svc.Health(ctx); err != nil {
						if !s.isStarting(svc.Name()) {
							s.events.write(Event{
								Timestamp: time.Now(),
								Event:     EventUnhealthy,
								Service:   svc.Name(),
								Error:     err.Error(),
								Message:   fmt.Sprintf("health check failed: %s", err),
							})
							slog.Warn("service unhealthy", "name", svc.Name(), "error", err)
						}
					} else {
						s.resetBackoff(svc.Name())
					}
				}
			}
		}
	}
}

func (s *Supervisor) handleCrash(ctx context.Context, svc serviceapi.Interface) {
	s.events.write(Event{
		Timestamp: time.Now(),
		Event:     EventCrashed,
		Service:   svc.Name(),
		Message:   fmt.Sprintf("%s process exited", svc.Type()),
	})
	slog.Warn("service not running, restarting", "name", svc.Name())

	s.mu.Lock()
	rs := s.restarts[svc.Name()]
	if rs == nil {
		rs = &restartState{}
		s.restarts[svc.Name()] = rs
	}
	rs.count++
	backoff := rs.wait
	if backoff == 0 {
		backoff = DefaultInitialBackoff
	} else {
		backoff *= 2
	}
	if backoff > s.maxBackoff {
		backoff = s.maxBackoff
	}
	rs.wait = backoff
	restartCount := rs.count
	backoffStr := backoff.String()
	s.mu.Unlock()

	s.events.write(Event{
		Timestamp: time.Now(),
		Event:     EventRestarting,
		Service:   svc.Name(),
		Message:   fmt.Sprintf("restart attempt %d after %s", restartCount, backoffStr),
		Restarts:  restartCount,
		Backoff:   backoffStr,
	})
	slog.Info("restarting service", "name", svc.Name(), "attempt", restartCount, "backoff", backoffStr)

	time.Sleep(backoff)

	if err := svc.Start(ctx); err != nil {
		s.events.write(Event{
			Timestamp: time.Now(),
			Event:     EventCrashed,
			Service:   svc.Name(),
			Error:     err.Error(),
			Message:   fmt.Sprintf("restart attempt %d failed: %s", restartCount, err),
		})
		slog.Error("restart failed", "name", svc.Name(), "error", err)
	} else {
		s.resetBackoff(svc.Name())
		s.events.write(Event{
			Timestamp: time.Now(),
			Event:     EventHealthy,
			Service:   svc.Name(),
			Message:   fmt.Sprintf("restart %d succeeded", restartCount),
		})
		slog.Info("restart succeeded", "name", svc.Name())
	}
}

func (s *Supervisor) resetBackoff(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rs := s.restarts[name]; rs != nil && rs.count > 0 {
		s.restarts[name] = &restartState{}
	}
}

func (s *Supervisor) markStarting(name string, starting bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if starting {
		s.starting[name] = true
	} else {
		delete(s.starting, name)
	}
}

func (s *Supervisor) isStarting(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.starting[name]
}

// Stop gracefully stops all services concurrently. It respects the supplied
// context timeout and returns once all stop calls have completed or the
// context expires.
func (s *Supervisor) Stop(ctx context.Context) {
	var wg sync.WaitGroup

	for _, svc := range s.services {
		svc := svc
		wg.Add(1)
		go func() {
			defer wg.Done()
			slog.Info("stopping service", "name", svc.Name())
			s.events.write(Event{
				Timestamp: time.Now(),
				Event:     EventStopped,
				Service:   svc.Name(),
				Message:   fmt.Sprintf("stopping %s", svc.Type()),
			})
			if err := svc.Stop(ctx); err != nil {
				slog.Error("error stopping service", "name", svc.Name(), "error", err)
			}
		}()
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		slog.Info("all services stopped")
	case <-ctx.Done():
		slog.Warn("stop timed out", "error", ctx.Err())
	}
}

// EventsPath returns the path to the event log file. It is exposed mainly for
// tests.
func (s *Supervisor) EventsPath() string {
	return s.events.path
}
