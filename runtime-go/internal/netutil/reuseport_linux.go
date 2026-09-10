//go:build linux

package netutil

import (
	"context"
	"net"
	"syscall"
	"golang.org/x/sys/unix"
)

// openListenersPlatform 在 Linux 上经 SO_REUSEPORT 打开同端口多 accept 队列。
func openListenersPlatform(ctx context.Context, addr string, n int) ([]net.Listener, error) {
	if n < 1 {
		n = 1
	}
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			var opErr error
			err := c.Control(func(fd uintptr) {
				opErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1)
			})
			if err != nil {
				return err
			}
			return opErr
		},
	}
	lns := make([]net.Listener, 0, n)
	for i := 0; i < n; i++ {
		ln, err := lc.Listen(ctx, "tcp", addr)
		if err != nil {
			for _, l := range lns {
				_ = l.Close()
			}
			return nil, err
		}
		lns = append(lns, ln)
	}
	return lns, nil
}
