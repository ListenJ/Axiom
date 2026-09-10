//go:build !linux

package agent

// NewPlatformLimiter returns the platform's default ResourceLimiter. On
// non-Linux platforms that is the accounting stub.
func NewPlatformLimiter() ResourceLimiter { return NewAccountingLimiter() }
