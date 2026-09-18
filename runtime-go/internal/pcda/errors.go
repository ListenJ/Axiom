package pcda

// Stable machine-readable error codes carried by observability.AppError.
const (
	// ErrCodeQueueFull indicates backpressure: a stage queue is saturated.
	ErrCodeQueueFull = "PCDA_QUEUE_FULL"
	// ErrCodeStageFailed indicates a stage handler exhausted L1 retries.
	ErrCodeStageFailed = "PCDA_STAGE_FAILED"
	// ErrCodeTxAborted indicates a 2PC stage transition was aborted.
	ErrCodeTxAborted = "PCDA_TX_ABORTED"
	// ErrCodeCycleExists indicates a duplicate cycle ID on Submit.
	ErrCodeCycleExists = "PCDA_CYCLE_EXISTS"
	// ErrCodeNotFound indicates an unknown cycle ID.
	ErrCodeNotFound = "PCDA_CYCLE_NOT_FOUND"
	// ErrCodePersist indicates a snapshot or WAL failure.
	ErrCodePersist = "PCDA_PERSIST_FAILED"
	// ErrCodeStopped indicates an operation on a stopped engine.
	ErrCodeStopped = "PCDA_ENGINE_STOPPED"
)
