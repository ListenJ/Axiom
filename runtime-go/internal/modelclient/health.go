package modelclient

import (
	"context"
	"net/http"
	"time"
)

// healthLoop probes every endpoint each HealthInterval. Unhealthy endpoints
// are removed from rotation (circuit open); each tick re-probes them, which
// acts as the half-open trial that closes the circuit once they recover.
func (c *Client) healthLoop() {
	defer c.stopped.Done()
	ticker := time.NewTicker(c.cfg.HealthInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.probeAll()
		}
	}
}

// probeAll checks every configured endpoint and updates health state and
// the endpoint-health gauge.
func (c *Client) probeAll() {
	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.Timeout)
	defer cancel()
	for _, ep := range c.cfg.Endpoints {
		healthy := c.probe(ctx, ep)
		c.health[ep].Store(healthy)
		if healthy {
			c.metric.endpointHealth.WithLabelValues(ep).Set(1)
		} else {
			c.metric.endpointHealth.WithLabelValues(ep).Set(0)
		}
	}
}

// probe performs a single GET {endpoint}/health; any 2xx is healthy.
func (c *Client) probe(ctx context.Context, endpoint string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
