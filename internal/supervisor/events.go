package supervisor

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type EventType string

const (
	EventStarted    EventType = "started"
	EventHealthy    EventType = "healthy"
	EventCrashed    EventType = "crashed"
	EventRestarting EventType = "restarting"
	EventUnhealthy  EventType = "unhealthy"
	EventStopped    EventType = "stopped"
)

type Event struct {
	Timestamp time.Time `json:"timestamp"`
	Event     EventType `json:"event"`
	Service   string    `json:"service"`
	Error     string    `json:"error,omitempty"`
	Message   string    `json:"message,omitempty"`
	Restarts  int       `json:"restarts,omitempty"`
	Backoff   string    `json:"backoff,omitempty"`
}

type EventLog struct {
	path string
	mu   sync.Mutex
}

func NewEventLog(path string) *EventLog {
	return &EventLog{path: path}
}

// Path returns the event log file path.
func (el *EventLog) Path() string {
	return el.path
}

func (el *EventLog) write(ev Event) {
	el.mu.Lock()
	defer el.mu.Unlock()

	dir := filepath.Dir(el.path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		slog.Error("failed to create event log dir", "error", err)
		return
	}

	f, err := os.OpenFile(el.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		slog.Error("failed to open event log", "error", err)
		return
	}
	defer f.Close()

	data, err := json.Marshal(ev)
	if err != nil {
		slog.Error("failed to marshal event", "error", err)
		return
	}

	data = append(data, '\n')
	if _, err := f.Write(data); err != nil {
		slog.Error("failed to write event", "error", err)
	}
}

func ReadEvents(path string, limit int) ([]Event, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var events []Event
	var malformed []int
	dec := json.NewDecoder(f)
	line := 1
	for dec.More() {
		var ev Event
		if err := dec.Decode(&ev); err != nil {
			malformed = append(malformed, line)
			line++
			continue
		}
		events = append(events, ev)
		line++
	}

	if len(malformed) > 0 {
		slog.Warn("skipped malformed event lines", "lines", malformed)
	}

	if limit > 0 && len(events) > limit {
		events = events[len(events)-limit:]
	}
	return events, nil
}
