package agent

// Predictor estimates task duration and memory consumption with an
// exponential moving average (EMA) over observed samples. It is not safe
// for concurrent use; callers (Scheduler) hold a lock.
type Predictor struct {
	alpha    float64
	duration float64
	memory   float64
	samples  int
}

// NewPredictor creates a predictor with the given EMA smoothing factor
// (0 < alpha <= 1; higher reacts faster to new samples).
func NewPredictor(alpha float64) *Predictor {
	if alpha <= 0 || alpha > 1 {
		alpha = 0.3
	}
	return &Predictor{alpha: alpha}
}

// Observe folds one observed sample into the EMA.
func (p *Predictor) Observe(durationSec, memoryBytes float64) {
	if p.samples == 0 {
		p.duration = durationSec
		p.memory = memoryBytes
	} else {
		p.duration = p.alpha*durationSec + (1-p.alpha)*p.duration
		p.memory = p.alpha*memoryBytes + (1-p.alpha)*p.memory
	}
	p.samples++
}

// Duration returns the predicted task duration in seconds.
func (p *Predictor) Duration() float64 { return p.duration }

// Memory returns the predicted task memory consumption in bytes.
func (p *Predictor) Memory() float64 { return p.memory }

// Samples returns the number of observed samples.
func (p *Predictor) Samples() int { return p.samples }
