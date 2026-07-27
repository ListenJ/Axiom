package search

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"runtime-go/internal/observability"
)

// RedisLock is a DistLock backed by Redis: acquisition is SET key token NX
// PX ttl, release is a compare-and-delete Lua script (only the token owner
// can release), and a background watchdog renews the TTL at ttl/3 intervals
// so a long critical section does not lose the lock while still alive.
type RedisLock struct {
	client        redis.UniversalClient
	retryInterval time.Duration
}

// NewRedisLock creates a RedisLock on client.
func NewRedisLock(client redis.UniversalClient) *RedisLock {
	return &RedisLock{client: client, retryInterval: 50 * time.Millisecond}
}

// releaseScript deletes the key only when it is still held by this token.
var releaseScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("del", KEYS[1])
else
	return 0
end
`)

// renewScript extends the TTL only when the key is still held by this token.
var renewScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("pexpire", KEYS[1], ARGV[2])
else
	return 0
end
`)

// Lock acquires key with the given TTL, retrying until acquired or ctx is
// done (LOCK_TIMEOUT).
func (r *RedisLock) Lock(ctx context.Context, key string, ttl time.Duration) (UnlockFunc, error) {
	if ttl <= 0 {
		ttl = time.Minute
	}
	token := newLockToken()
	for {
		ok, err := r.client.SetNX(ctx, key, token, ttl).Result()
		if err != nil {
			return nil, observability.WrapError(ErrCodeLockError, "redis SET NX failed", err).
				WithContext("key", key)
		}
		if ok {
			done := make(chan struct{})
			go r.watchdog(key, token, ttl, done)
			var once sync.Once
			return func(uctx context.Context) error {
				var relErr error
				once.Do(func() {
					close(done)
					relErr = releaseScript.Run(uctx, r.client, []string{key}, token).Err()
				})
				return relErr
			}, nil
		}
		select {
		case <-ctx.Done():
			return nil, observability.NewAppError(ErrCodeLockTimeout, "timed out acquiring lock").
				WithContext("key", key)
		case <-time.After(r.retryInterval):
		}
	}
}

// watchdog renews the lock TTL until done is closed.
func (r *RedisLock) watchdog(key, token string, ttl time.Duration, done chan struct{}) {
	interval := ttl / 3
	if interval < 50*time.Millisecond {
		interval = 50 * time.Millisecond
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(context.Background(), interval)
			_ = renewScript.Run(ctx, r.client, []string{key}, token, int64(ttl/time.Millisecond)).Err()
			cancel()
		}
	}
}

// newLockToken returns a random 16-byte hex token identifying the holder.
func newLockToken() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
