package observability

import (
	"encoding/json"
	"fmt"
	"runtime/debug"
	"strings"
)

// AppError is the standard structured error used across runtime-go modules.
// It carries a stable machine-readable Code, a human-readable Message, an
// optional wrapped Cause, arbitrary Context key/value pairs, and the stack
// trace captured at construction time.
type AppError struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Cause   error             `json:"-"`
	Context map[string]string `json:"context,omitempty"`
	Stack   string            `json:"stack,omitempty"`
}

// NewAppError creates an AppError with the given code and message, capturing
// the current goroutine stack.
func NewAppError(code, message string) *AppError {
	return &AppError{
		Code:    code,
		Message: message,
		Stack:   string(debug.Stack()),
	}
}

// WrapError creates an AppError wrapping cause, capturing the current stack.
// A nil cause returns nil.
func WrapError(code, message string, cause error) *AppError {
	if cause == nil {
		return nil
	}
	return &AppError{
		Code:    code,
		Message: message,
		Cause:   cause,
		Stack:   string(debug.Stack()),
	}
}

// WithContext attaches a key/value pair and returns the error for chaining.
func (e *AppError) WithContext(key, value string) *AppError {
	if e.Context == nil {
		e.Context = make(map[string]string, 1)
	}
	e.Context[key] = value
	return e
}

// Error implements the error interface.
func (e *AppError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s", e.Code, e.Message)
	if e.Cause != nil {
		fmt.Fprintf(&b, ": %v", e.Cause)
	}
	return b.String()
}

// Unwrap returns the wrapped cause, enabling errors.Is / errors.As.
func (e *AppError) Unwrap() error { return e.Cause }

// jsonError is the wire shape of AppError; Cause is rendered as a string.
type jsonError struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Cause   string            `json:"cause,omitempty"`
	Context map[string]string `json:"context,omitempty"`
	Stack   string            `json:"stack,omitempty"`
}

// ToJSON serializes the error to JSON, with Cause rendered as a string.
func (e *AppError) ToJSON() ([]byte, error) {
	je := jsonError{
		Code:    e.Code,
		Message: e.Message,
		Context: e.Context,
		Stack:   e.Stack,
	}
	if e.Cause != nil {
		je.Cause = e.Cause.Error()
	}
	return json.Marshal(je)
}

// MarshalJSON implements json.Marshaler so AppError serializes sensibly in
// any enclosing structure.
func (e *AppError) MarshalJSON() ([]byte, error) { return e.ToJSON() }

// LogString returns a compact single-line, log-friendly representation.
func (e *AppError) LogString() string {
	var b strings.Builder
	b.WriteString(e.Error())
	if len(e.Context) > 0 {
		b.WriteString(" |")
		for k, v := range e.Context {
			fmt.Fprintf(&b, " %s=%s", k, v)
		}
	}
	return b.String()
}
