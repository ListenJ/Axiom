package netutil

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestParseListenerCount(t *testing.T) {
	cases := []struct {
		env  string
		gmp  int
		want int
	}{
		{"", 8, 8},     // 缺省=GOMAXPROCS
		{"", 32, 16},   // 上限钳制
		{"", 0, 1},     // 下限保护
		{"4", 8, 4},    // 显式覆盖
		{"1", 8, 1},    // 单队列（回退模式）
		{"99", 2, 16},  // 超限钳制
		{"abc", 6, 6},  // 非法→缺省
		{"-3", 5, 5},   // 非法→缺省
	}
	for _, c := range cases {
		if got := ParseListenerCount(c.env, c.gmp); got != c.want {
			t.Errorf("ParseListenerCount(%q,%d)=%d want %d", c.env, c.gmp, got, c.want)
		}
	}
}

func TestServeAllShutdownOnCanceledCtx(t *testing.T) {
	srv := &http.Server{Handler: http.NewServeMux()}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(150 * time.Millisecond)
		cancel()
	}()
	if err := ServeAll(ctx, srv, "127.0.0.1:0", "TEST_LISTENERS", "test"); err != nil {
		t.Fatalf("ServeAll: %v", err)
	}
}
