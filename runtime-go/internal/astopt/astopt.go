// Package astopt is a static analysis tool that scans Go source trees for
// common performance anti-patterns and reports them as structured findings.
//
// The scanner is intentionally intra-procedural and heuristic: it parses
// each file with go/parser and inspects the AST without type checking.
// Findings are candidates for human review, not proof of a problem.
package astopt

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
)

// Severity classifies how urgent a finding is.
type Severity string

const (
	// Warn marks findings that are likely real performance problems on hot
	// paths and deserve a benchmark-backed fix.
	Warn Severity = "warn"
	// Info marks hints that are worth a look but usually harmless.
	Info Severity = "info"
)

// Rule IDs emitted by the scanner.
const (
	RuleStringConcatLoop = "string-concat-loop"
	RuleSprintfInLoop    = "sprintf-in-loop"
	RuleHeapAllocInLoop  = "heap-alloc-in-loop"
	RuleUnbufferedChan   = "unbuffered-chan"
)

// Finding is a single located performance anti-pattern candidate.
type Finding struct {
	File     string   // path relative to the scanned directory
	Line     int      // 1-based line number
	Rule     string   // one of the Rule* constants
	Severity Severity // Warn or Info
	Message  string   // human-readable explanation and suggestion
}

// Scan walks dir for .go files (skipping hidden directories, vendor and
// testdata) and returns all findings sorted by file and line.
func Scan(dir string) ([]Finding, error) {
	var findings []Finding
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if path != dir && (strings.HasPrefix(name, ".") || name == "vendor" || name == "testdata") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		fs, err := scanFile(path)
		if err != nil {
			return fmt.Errorf("astopt: %s: %w", path, err)
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			rel = path
		}
		for i := range fs {
			fs[i].File = filepath.ToSlash(rel)
		}
		findings = append(findings, fs...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(findings, func(i, j int) bool {
		if findings[i].File != findings[j].File {
			return findings[i].File < findings[j].File
		}
		return findings[i].Line < findings[j].Line
	})
	return findings, nil
}

// FormatReport renders findings as a plain-text report, one line per
// finding plus a summary footer. An empty slice yields just the summary.
func FormatReport(findings []Finding) string {
	var b strings.Builder
	warns, infos := 0, 0
	for _, f := range findings {
		fmt.Fprintf(&b, "%s:%d: [%s] %s: %s\n", f.File, f.Line, f.Severity, f.Rule, f.Message)
		if f.Severity == Warn {
			warns++
		} else {
			infos++
		}
	}
	fmt.Fprintf(&b, "astopt: %d finding(s) (%d warn, %d info)\n", len(findings), warns, infos)
	return b.String()
}

// scanFile parses one Go file and returns its findings with the File field
// left blank (the caller fills in the relative path).
func scanFile(path string) ([]Finding, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}
	var findings []Finding
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		s := &fileScanner{fset: fset, strings: stringVars(fn.Body)}
		ast.Inspect(fn.Body, s.visit)
		findings = append(findings, s.findings...)
	}
	return findings, nil
}

// fileScanner carries per-function scan state.
type fileScanner struct {
	fset     *token.FileSet
	strings  map[string]bool // identifiers evidently holding strings
	findings []Finding
}

// visit implements the ast.Inspect callback: every loop statement gets its
// own body scanned once; nested loops are reached by the same outer walk.
// Function-wide rules (unbuffered channel creation) are checked here so
// each call site is reported exactly once regardless of loop nesting.
func (s *fileScanner) visit(n ast.Node) bool {
	if n == nil {
		return true
	}
	if body := loopBody(n); body != nil {
		s.checkLoopBody(body)
		return true
	}
	if c, ok := n.(*ast.CallExpr); ok && isUnbufferedChanMake(c) {
		s.add(c, RuleUnbufferedChan, Info,
			"unbuffered channel creation; make sure the rendezvous is intended, otherwise add a capacity")
	}
	return true
}

// isUnbufferedChanMake reports whether c is `make(chan T)` with no
// capacity argument.
func isUnbufferedChanMake(c *ast.CallExpr) bool {
	if builtinName(c) != "make" || len(c.Args) != 1 {
		return false
	}
	_, isChan := c.Args[0].(*ast.ChanType)
	return isChan
}

// checkLoopBody applies the loop-scoped rules to every node directly inside
// a loop body. Nested loop bodies and function literals are skipped here;
// the outer walk reports nested loops at their own level, and closure
// bodies execute at call time rather than inline with the loop.
func (s *fileScanner) checkLoopBody(body *ast.BlockStmt) {
	ast.Inspect(body, func(n ast.Node) bool {
		if n == nil {
			return true
		}
		switch n.(type) {
		case *ast.ForStmt, *ast.RangeStmt, *ast.FuncLit:
			return false
		}
		s.checkNode(n)
		return true
	})
}

// loopBody returns the body of a for/range statement, or nil.
func loopBody(n ast.Node) *ast.BlockStmt {
	switch l := n.(type) {
	case *ast.ForStmt:
		return l.Body
	case *ast.RangeStmt:
		return l.Body
	}
	return nil
}

// checkNode applies the loop-scoped rules to a single node known to sit
// inside a loop body.
func (s *fileScanner) checkNode(n ast.Node) {
	switch node := n.(type) {
	case *ast.AssignStmt:
		if node.Tok == token.ADD_ASSIGN {
			s.checkStringConcat(node)
		}
	case *ast.CallExpr:
		s.checkCall(node)
	case *ast.UnaryExpr:
		if node.Op == token.AND {
			if _, ok := node.X.(*ast.CompositeLit); ok {
				s.add(node, RuleHeapAllocInLoop, Warn,
					"composite literal address taken inside loop body; candidate for hoisting or reuse (sync.Pool)")
			}
		}
	}
}

// checkStringConcat reports `x += ...` string concatenation inside a loop.
// Without type information we flag the statement when the left operand is a
// plain identifier known to hold a string, or when the right-hand side
// evidently evaluates to a string (literal, conversion, strings/fmt call).
func (s *fileScanner) checkStringConcat(a *ast.AssignStmt) {
	if len(a.Lhs) != 1 || len(a.Rhs) != 1 {
		return
	}
	if looksLikeString(a.Rhs[0], s.strings) || (isIdent(a.Lhs[0]) && s.strings[identName(a.Lhs[0])]) {
		s.add(a, RuleStringConcatLoop, Warn,
			"string concatenation with += inside loop; use strings.Builder instead")
	}
}

// checkCall reports loop-scoped call anti-patterns: fmt.Sprintf and heap
// allocations via new/make. Channel creation is a function-wide rule and
// is handled by visit instead.
func (s *fileScanner) checkCall(c *ast.CallExpr) {
	if isPkgCall(c, "fmt", "Sprintf") {
		s.add(c, RuleSprintfInLoop, Warn,
			"fmt.Sprintf inside loop; prefer strconv or precompute the format")
		return
	}
	switch builtinName(c) {
	case "new":
		s.add(c, RuleHeapAllocInLoop, Warn,
			"new() allocation inside loop body; candidate for hoisting or reuse")
	case "make":
		if len(c.Args) > 0 {
			if _, isChan := c.Args[0].(*ast.ChanType); isChan {
				return // channel creation is reported by visit, once per site
			}
		}
		s.add(c, RuleHeapAllocInLoop, Warn,
			"make() allocation inside loop body; candidate for hoisting or reuse")
	}
}

// add records a finding at the position of n.
func (s *fileScanner) add(n ast.Node, rule string, sev Severity, msg string) {
	s.findings = append(s.findings, Finding{
		Line:     s.fset.Position(n.Pos()).Line,
		Rule:     rule,
		Severity: sev,
		Message:  msg,
	})
}

// stringVars returns the set of identifiers in body that evidently hold
// strings: declared via `var x string` or defined from a string-looking
// expression such as `x := ""`, `x := string(b)` or `x := fmt.Sprintf(...)`.
func stringVars(body *ast.BlockStmt) map[string]bool {
	vars := map[string]bool{}
	ast.Inspect(body, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.ValueSpec: // var x string
			if id, ok := node.Type.(*ast.Ident); ok && id.Name == "string" {
				for _, name := range node.Names {
					vars[name.Name] = true
				}
			}
		case *ast.AssignStmt: // x := <string expr>
			if node.Tok != token.DEFINE {
				return true
			}
			for i, lhs := range node.Lhs {
				if !isIdent(lhs) || i >= len(node.Rhs) {
					continue
				}
				if looksLikeString(node.Rhs[i], vars) {
					vars[identName(lhs)] = true
				}
			}
		}
		return true
	})
	return vars
}

// looksLikeString heuristically decides whether expr evaluates to a string:
// a string literal, a string(...) conversion, a strings.* / fmt.Sprint* /
// strconv.Itoa/Format* call, a known string variable, or a binary + of
// string-looking operands.
func looksLikeString(e ast.Expr, vars map[string]bool) bool {
	switch ex := e.(type) {
	case *ast.BasicLit:
		return ex.Kind == token.STRING
	case *ast.Ident:
		return vars[ex.Name]
	case *ast.CallExpr:
		if id, ok := ex.Fun.(*ast.Ident); ok && id.Name == "string" {
			return true
		}
		if sel, ok := ex.Fun.(*ast.SelectorExpr); ok {
			if pkg, ok := sel.X.(*ast.Ident); ok {
				switch pkg.Name {
				case "strings":
					return true
				case "fmt":
					return strings.HasPrefix(sel.Sel.Name, "Sprint")
				case "strconv":
					return strings.HasPrefix(sel.Sel.Name, "Itoa") || strings.HasPrefix(sel.Sel.Name, "Format")
				}
			}
		}
	case *ast.BinaryExpr:
		if ex.Op == token.ADD {
			return looksLikeString(ex.X, vars) || looksLikeString(ex.Y, vars)
		}
	case *ast.ParenExpr:
		return looksLikeString(ex.X, vars)
	}
	return false
}

// isPkgCall reports whether c is a call of the form pkg.Name(...).
func isPkgCall(c *ast.CallExpr, pkg, name string) bool {
	sel, ok := c.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && id.Name == pkg && sel.Sel.Name == name
}

// builtinName returns the function name when c is a plain identifier call
// (candidate builtin like new/make), or "" otherwise.
func builtinName(c *ast.CallExpr) string {
	if id, ok := c.Fun.(*ast.Ident); ok {
		return id.Name
	}
	return ""
}

func isIdent(e ast.Expr) bool {
	_, ok := e.(*ast.Ident)
	return ok
}

func identName(e ast.Expr) string {
	if id, ok := e.(*ast.Ident); ok {
		return id.Name
	}
	return ""
}
