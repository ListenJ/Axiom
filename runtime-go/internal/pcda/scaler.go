package pcda

import "time"

// autoscaleLoop runs the resource control loop: every interval it inspects
// per-stage queue depth and worker counts and rebalances workers and batch
// sizes within the configured bounds.
func (e *Engine) autoscaleLoop(interval time.Duration) {
	defer e.wg.Done()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-t.C:
			e.scaleOnce()
		}
	}
}

// scaleOnce performs one control-loop iteration over all stages:
//
//   - scale up: backlog per worker above the watermark and headroom remains
//   - scale down: stage idle (empty queue) and above the minimum
//   - batch size: doubled under backlog (bounded), halved back toward the
//     configured size when idle
//
// It also refreshes the queue-depth, worker-count and batch-size gauges.
func (e *Engine) scaleOnce() {
	for _, p := range e.pools {
		depth := p.queue.Len()
		workers := p.workerCount()
		name := p.stage.String()

		switch {
		case depth > workers*scaleUpWatermark && workers < e.cfg.MaxWorkers:
			p.setWorkers(workers + 1)
			workers++
		case depth == 0 && workers > e.cfg.MinWorkers:
			p.setWorkers(workers - 1)
			workers--
		}

		bs := int(p.batchSize.Load())
		switch {
		case depth > workers*scaleUpWatermark:
			p.setBatchSize(bs * 2)
		case depth == 0 && bs > e.cfg.BatchSize:
			p.setBatchSize(bs / 2)
		}

		e.metrics.queueDepth.WithLabelValues(name).Set(float64(depth))
		e.metrics.workerCount.WithLabelValues(name).Set(float64(workers))
		e.metrics.batchSize.WithLabelValues(name).Set(float64(p.batchSize.Load()))
		e.metrics.module.SampleRuntime()
	}
}
