package local

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/anomalyco/sandbox-manager/pkg/secret"
	"golang.org/x/term"
)

const (
	keyFile    = ".sandbox-key"
	storeDir   = ".sandbox"
	storeFile  = "secrets.enc"
	envKey     = "SANDBOX_KEY"
	envPassphrase = "SANDBOX_PASSPHRASE"
)

type Backend struct {
	mu        sync.RWMutex
	storePath string
	keyPath   string
	secrets   map[string]string
	key       []byte
}

func New() *Backend {
	home, _ := os.UserHomeDir()
	return &Backend{
		storePath: filepath.Join(home, storeDir, storeFile),
		keyPath:   filepath.Join(home, storeDir, keyFile),
		secrets:   make(map[string]string),
	}
}

func (b *Backend) Name() string { return "local" }

func (b *Backend) Init(_ context.Context, _ secret.SecretBackend) error {
	if err := os.MkdirAll(filepath.Dir(b.storePath), 0700); err != nil {
		return fmt.Errorf("create store dir: %w", err)
	}

	key, err := b.loadKey()
	if err != nil {
		return fmt.Errorf("load key: %w", err)
	}
	b.key = key

	if err := b.loadSecrets(); err != nil {
		return fmt.Errorf("load secrets: %w", err)
	}

	return nil
}

func (b *Backend) Resolve(_ context.Context, key string) (string, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	val, ok := b.secrets[key]
	if !ok {
		return "", fmt.Errorf("secret %q not found", key)
	}
	return val, nil
}

func (b *Backend) List(_ context.Context) ([]string, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	keys := make([]string, 0, len(b.secrets))
	for k := range b.secrets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys, nil
}

func (b *Backend) Set(_ context.Context, key, value string) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.secrets[key] = value
	return b.saveSecrets()
}

func (b *Backend) Delete(_ context.Context, key string) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	delete(b.secrets, key)
	return b.saveSecrets()
}

func (b *Backend) loadKey() ([]byte, error) {
	if encoded := os.Getenv(envKey); encoded != "" {
		key := make([]byte, 32)
		copy(key, encoded)
		return key, nil
	}

	if pass := os.Getenv(envPassphrase); pass != "" {
		return deriveKey([]byte(pass)), nil
	}

	data, err := os.ReadFile(b.keyPath)
	if err == nil {
		return data, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	return b.createKeyInteractive()
}

func (b *Backend) createKeyInteractive() ([]byte, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return nil, fmt.Errorf("no key found and no TTY available; set %s or %s", envKey, envPassphrase)
	}

	fmt.Fprint(os.Stderr, "No encryption key found. Creating a new one...\n\n")
	fmt.Fprint(os.Stderr, "Enter a passphrase (used to encrypt your secrets): ")
	pass, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprint(os.Stderr, "\n")
	if err != nil {
		return nil, fmt.Errorf("read passphrase: %w", err)
	}
	if len(pass) == 0 {
		return nil, fmt.Errorf("passphrase cannot be empty")
	}

	fmt.Fprint(os.Stderr, "Confirm passphrase: ")
	confirm, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprint(os.Stderr, "\n")
	if err != nil {
		return nil, fmt.Errorf("read confirmation: %w", err)
	}
	if string(pass) != string(confirm) {
		return nil, fmt.Errorf("passphrases do not match")
	}

	key := deriveKey(pass)
	if err := os.WriteFile(b.keyPath, key, 0600); err != nil {
		return nil, fmt.Errorf("write key file: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Key saved to %s\n", b.keyPath)
	return key, nil
}

func (b *Backend) loadSecrets() error {
	data, err := os.ReadFile(b.storePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}

	plaintext, err := decrypt(b.key, data)
	if err != nil {
		return fmt.Errorf("decrypt secrets: %w", err)
	}

	return json.Unmarshal(plaintext, &b.secrets)
}

func (b *Backend) saveSecrets() error {
	plaintext, err := json.Marshal(b.secrets)
	if err != nil {
		return fmt.Errorf("marshal secrets: %w", err)
	}

	encrypted, err := encrypt(b.key, plaintext)
	if err != nil {
		return fmt.Errorf("encrypt secrets: %w", err)
	}

	return os.WriteFile(b.storePath, encrypted, 0600)
}

func deriveKey(passphrase []byte) []byte {
	key := sha256.Sum256(passphrase)
	for range 65535 {
		key = sha256.Sum256(key[:])
	}
	return key[:]
}

func encrypt(key, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	return aesGCM.Seal(nonce, nonce, plaintext, nil), nil
}

func decrypt(key, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := aesGCM.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	return aesGCM.Open(nil, nonce, ciphertext, nil)
}

var _ interface {
	Resolve(context.Context, string) (string, error)
	List(context.Context) ([]string, error)
	Set(context.Context, string, string) error
	Delete(context.Context, string) error
} = (*Backend)(nil)
