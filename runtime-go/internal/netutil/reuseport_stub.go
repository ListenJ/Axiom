//go:build !linux

package netutil

import (
	"context"
	"fmt"
	"net"
)

// openListenersPlatform 非 Linux 平台不支持 SO_REUSEPORT 多队列，
// 安全回退为单监听（行为与历史单队列一致）。
func openListenersPlatform(ctx context.Context, addr string, n int) ([]net.Listener, error) {
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", addr, err)
	}
	return []net.Listener{ln}, nil
}
