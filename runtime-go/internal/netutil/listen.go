// Package netutil 提供单机并发强化共用件（P2-12b 单机并发包）。
//
// 单一 http.Server 监听 = 单一 accept 队列，高连接速率下成为入口瓶颈
// （实测 Windows ~13.7k entry QPS 出现 connectex actively refused）。
// Linux 上经 SO_REUSEPORT 打开多个内核 accept 队列，由内核在多核间
// 均衡新连接；不支持的平台安全回退为单监听（行为与历史一致）。
package netutil

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"sync"
	"time"
)

// ParseListenerCount 解析监听器数量环境值：缺省为 GOMAXPROCS，
// 钳制到 [1, 16]。非法输入按缺省处理。
func ParseListenerCount(envValue string, gomaxprocs int) int {
	def := gomaxprocs
	if def < 1 {
		def = 1
	}
	if def > 16 {
		def = 16
	}
	if envValue == "" {
		return def
	}
	n, err := strconv.Atoi(envValue)
	if err != nil || n < 1 {
		return def
	}
	if n > 16 {
		n = 16
	}
	return n
}

// OpenListeners 在 addr 上打开 n 个监听器。仅 Linux 支持同端口多队列；
// 其他平台忽略多余请求返回单个监听器。
func OpenListeners(ctx context.Context, addr string, n int) ([]net.Listener, error) {
	return openListenersPlatform(ctx, addr, n)
}

// ServeAll 用 n 个 acceptor 服务 srv，并接管 ctx 取消后的优雅停机。
// 替代 srv.ListenAndServe 的单队列模式。
func ServeAll(ctx context.Context, srv *http.Server, addr, envKey, svcName string) error {
	n := ParseListenerCount(os.Getenv(envKey), runtime.GOMAXPROCS(0))
	lns, err := OpenListeners(ctx, addr, n)
	if err != nil {
		return fmt.Errorf("%s: open listeners: %w", svcName, err)
	}
	errCh := make(chan error, len(lns))
	var wg sync.WaitGroup
	for _, ln := range lns {
		wg.Add(1)
		go func(l net.Listener) {
			defer wg.Done()
			errCh <- srv.Serve(l)
		}(ln)
	}
	log.Printf("%s: listening on %s (%d acceptor(s))", svcName, addr, len(lns))
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		return nil
	}
}
