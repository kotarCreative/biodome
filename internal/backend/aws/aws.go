package aws

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/anomalyco/sandbox-manager/pkg/secret"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager/types"
)

type Backend struct {
	svc    *secretsmanager.Client
	prefix string
}

func New() *Backend {
	return &Backend{}
}

func (b *Backend) Name() string { return "aws" }

func (b *Backend) Init(_ context.Context, local secret.SecretBackend) error {
	// Attempt 1: credential chaining through local backend
	if local != nil {
		keyID, err1 := local.Resolve(context.Background(), "aws_access_key_id")
		secret, err2 := local.Resolve(context.Background(), "aws_secret_access_key")
		region, err3 := local.Resolve(context.Background(), "aws_region")
		if err1 == nil && err2 == nil && err3 == nil {
			cfg, err := config.LoadDefaultConfig(context.Background(),
				config.WithRegion(region),
				config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(keyID, secret, "")),
			)
			if err != nil {
				return fmt.Errorf("aws config from chained creds: %w", err)
			}
			b.svc = secretsmanager.NewFromConfig(cfg)
			return nil
		}
	}

	// Attempt 2: AWS SDK default chain (env vars, ~/.aws/credentials, IAM roles, etc.)
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		return fmt.Errorf("aws config: %w", err)
	}
	b.svc = secretsmanager.NewFromConfig(cfg)

	return nil
}

func (b *Backend) Resolve(ctx context.Context, key string) (string, error) {
	if b.svc == nil {
		return "", fmt.Errorf("aws backend not initialized")
	}

	input := &secretsmanager.GetSecretValueInput{
		SecretId: aws.String(key),
	}

	out, err := b.svc.GetSecretValue(ctx, input)
	if err != nil {
		var nfe *types.ResourceNotFoundException
		if errors.As(err, &nfe) {
			return "", fmt.Errorf("secret %q not found in AWS Secrets Manager", key)
		}
		return "", fmt.Errorf("get %s: %w", key, err)
	}

	if out.SecretString != nil {
		return *out.SecretString, nil
	}

	return "", fmt.Errorf("secret %q has no string value (binary secrets not supported)", key)
}

func (b *Backend) List(ctx context.Context) ([]string, error) {
	if b.svc == nil {
		return nil, fmt.Errorf("aws backend not initialized")
	}

	var keys []string
	paginator := secretsmanager.NewListSecretsPaginator(b.svc, &secretsmanager.ListSecretsInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list secrets: %w", err)
		}
		for _, s := range page.SecretList {
			keys = append(keys, *s.Name)
		}
	}

	sort.Strings(keys)
	return keys, nil
}

func (b *Backend) Set(ctx context.Context, key, value string) error {
	if b.svc == nil {
		return fmt.Errorf("aws backend not initialized")
	}

	_, err := b.svc.CreateSecret(ctx, &secretsmanager.CreateSecretInput{
		Name:         aws.String(key),
		SecretString: aws.String(value),
	})
	if err == nil {
		return nil
	}

	var alreadyExists *types.ResourceExistsException
	if errors.As(err, &alreadyExists) {
		_, err = b.svc.PutSecretValue(ctx, &secretsmanager.PutSecretValueInput{
			SecretId:     aws.String(key),
			SecretString: aws.String(value),
		})
		if err != nil {
			return fmt.Errorf("update %s: %w", key, err)
		}
		return nil
	}

	return fmt.Errorf("create %s: %w", key, err)
}

func (b *Backend) Delete(ctx context.Context, key string) error {
	if b.svc == nil {
		return fmt.Errorf("aws backend not initialized")
	}

	_, err := b.svc.DeleteSecret(ctx, &secretsmanager.DeleteSecretInput{
		SecretId:                   aws.String(key),
		RecoveryWindowInDays:       aws.Int64(7),
		ForceDeleteWithoutRecovery: aws.Bool(false),
	})
	if err != nil {
		var nfe *types.ResourceNotFoundException
		if errors.As(err, &nfe) {
			return fmt.Errorf("secret %q not found", key)
		}
		return fmt.Errorf("delete %s: %w", key, err)
	}

	return nil
}
