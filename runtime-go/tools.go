//go:build tools

// Package runtimego pins dependencies required only by build-tag tools.
// The Redis distributed-lock pin was removed on 2026-10-03 together with
// multi-machine search cluster mode.
package runtimego
