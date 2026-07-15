// Package process provides a small, reusable abstraction over a child process
// lifecycle. It is intentionally independent of any specific service so that
// service implementations can be kept focused on configuration and business
// logic rather than duplicated process management code.
package process

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Default timeouts and intervals. These are intentionally exported so they can
// be overridden by callers without magic numbers scattered through the code.
const (
	DefaultStopTimeout     = 10 * time.Second
	DefaultPortPollTimeout = 10 * time.Second
	DefaultPortDialTimeout = 1 * time.Second
	DefaultPortPollSleep   = 200 * time.Millisecond
)

// Process is a managed child process. It tracks the underlying os/exec.Cmd,
// the running state, and coordinates concurrent access.
//
// Process is safe for concurrent use, but Start and Stop should not be called
// concurrently on the same instance.
type Process struct {
	name string

	mu    sync.Mutex
	cmd   *exec.Cmd
	alive atomic.Bool
	done  chan struct{}
}

// New creates an unstarted Process for the given command name.
func New(name string) *Process {
	return &Process{name: name}
}

// IsRunning reports whether the process has been started and is believed to be
// running. The result is a snapshot; the process may exit immediately after.
func (p *Process) IsRunning() bool {
	return p.alive.Load()
}

// Start starts the provided command and redirects its output to the supplied
// log file. The command is executed with the provided context. A goroutine is
// spawned to wait for process exit and update the running state.
//
// Start is idempotent: if the process is already running, it returns nil.
func (p *Process) Start(ctx context.Context, cmd *exec.Cmd, logFile *os.File) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.alive.Load() {
		return nil
	}

	if cmd == nil {
		return fmt.Errorf("process: command is nil")
	}

	cmd.Stdout = logFile
	cmd.Stderr = logFile

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", p.name, err)
	}

	p.cmd = cmd
	p.alive.Store(true)
	p.done = make(chan struct{})

	go func() {
		werr := cmd.Wait()
		if logFile != nil {
			logFile.Close()
		}

		p.mu.Lock()
		if p.cmd == cmd {
			p.alive.Store(false)
			p.cmd = nil
		}
		p.mu.Unlock()

		if werr != nil {
			slog.Warn("process exited", "name", p.name, "error", werr)
		}
		close(p.done)
	}()

	return nil
}

// Stop sends SIGTERM to the process, waits for it to exit, and force-kills it
// if the supplied timeout is exceeded. If the process is not running, it
// returns nil.
func (p *Process) Stop(timeout time.Duration) error {
	p.mu.Lock()
	cmd := p.cmd
	done := p.done
	p.mu.Unlock()

	if cmd == nil || cmd.Process == nil {
		return nil
	}

	slog.Info("stopping process", "name", p.name)

	// Best-effort graceful shutdown.
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		_ = cmd.Process.Kill()
	}

	select {
	case <-done:
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		<-done
	}

	p.alive.Store(false)

	p.mu.Lock()
	if p.cmd == cmd {
		p.cmd = nil
	}
	p.mu.Unlock()

	return nil
}

// WaitForPort blocks until the given host:port is reachable, the context is
// cancelled, or the timeout expires. It is a convenience helper for services
// that expose a TCP port for health checks.
func WaitForPort(ctx context.Context, host string, port int, timeout time.Duration) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		conn, err := net.DialTimeout("tcp", addr, DefaultPortDialTimeout)
		if err == nil {
			conn.Close()
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(DefaultPortPollSleep):
		}
	}

	return fmt.Errorf("port %s not reachable within %v", addr, timeout)
}

// OpenLogFile opens (or creates) a log file in the given directory with a
// predictable name. The directory is created if it does not exist.
func OpenLogFile(dir, name string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create log dir %s: %w", dir, err)
	}
	path := filepath.Join(dir, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("open log file %s: %w", path, err)
	}
	return f, nil
}
