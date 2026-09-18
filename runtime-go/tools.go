//go:build tools

// Package runtimego pins dependencies that are required by upcoming modules
// but not yet imported by any code, so `go mod tidy` keeps them in go.mod.
package runtimego

import (
	// Pinned for searchd's distributed lock (implemented in a later phase).
	_ "github.com/redis/go-redis/v9"
)
